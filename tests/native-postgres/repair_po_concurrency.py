#!/usr/bin/env python3
"""Disposable native PostgreSQL concurrency gate; Python stdlib + PostgreSQL only.

Run: PG_BIN_DIR=/path/to/postgresql/bin python3 tests/native-postgres/repair_po_concurrency.py
No DSN, production configuration, credentials, or pre-existing database is accepted.
"""

import concurrent.futures
import ctypes
import ctypes.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261005235435_finance_repair_po_links.sql"
PG_BIN = Path(os.environ.get("PG_BIN_DIR", shutil.which("postgres") or "/missing/postgres"))
if PG_BIN.name == "postgres":
    PG_BIN = PG_BIN.parent
# Ignore libpq's ambient PG*, service files, passwords, and user startup files.
ENV = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
ENV.update({"LC_ALL": "C", "HOME": "/nonexistent"})
for ambient_key in list(os.environ):
    if ambient_key.startswith("PG"):
        del os.environ[ambient_key]


def uid(number):
    return f"00000000-0000-0000-0000-{number:012d}"


IDS = {name: uid(index + 1) for index, name in enumerate([
    "student", "other", "lead", "otherLead", "finance", "coach", "admin", "mentor",
    "readonly", "inactive", "financeAdmin", "financeAdminLead", "prospective",
])}
AREA, OTHER_AREA, EVENT, ISSUE, OTHER_ISSUE = map(uid, [100, 101, 200, 300, 301])
TABLES = [
    "public.finance_purchase_orders", "public.finance_po_approvals", "public.finance_po_revisions",
    "finance_private.history", "public.finance_seasons", "public.finance_budget_categories",
    "public.finance_po_budget", "public.finance_income", "public.finance_expenses",
    "public.team_notifications", "public.pit_issues", "public.pit_issue_events", "public.pit_battery_events",
]


class DatabaseError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class Connection:
    """Small synchronous libpq adapter; each concurrent worker owns one connection."""
    lib = None

    @classmethod
    def load_libpq(cls):
        local = PG_BIN.parent / "lib/libpq.so"
        cls.lib = ctypes.CDLL(str(local) if local.exists() else ctypes.util.find_library("pq"))
        signatures = {
            "PQconnectdb": (ctypes.c_void_p, [ctypes.c_char_p]),
            "PQstatus": (ctypes.c_int, [ctypes.c_void_p]),
            "PQerrorMessage": (ctypes.c_char_p, [ctypes.c_void_p]),
            "PQbackendPID": (ctypes.c_int, [ctypes.c_void_p]),
            "PQexec": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p]),
            "PQexecParams": (ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int,
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]),
            "PQresultStatus": (ctypes.c_int, [ctypes.c_void_p]),
            "PQresultErrorField": (ctypes.c_char_p, [ctypes.c_void_p, ctypes.c_int]),
            "PQresultErrorMessage": (ctypes.c_char_p, [ctypes.c_void_p]),
            "PQntuples": (ctypes.c_int, [ctypes.c_void_p]),
            "PQnfields": (ctypes.c_int, [ctypes.c_void_p]),
            "PQgetvalue": (ctypes.c_char_p, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
            "PQgetisnull": (ctypes.c_int, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
            "PQclear": (None, [ctypes.c_void_p]),
            "PQfinish": (None, [ctypes.c_void_p]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(cls.lib, name)
            function.restype, function.argtypes = result, arguments

    def __init__(self, cluster, database):
        # Explicit synthetic-only connection target; never consume DATABASE_URL or PG*.
        target = (f"host=127.0.0.1 hostaddr=127.0.0.1 port={cluster.port} dbname={database} "
                  "user=bridge_fixture connect_timeout=5 sslmode=disable gssencmode=disable "
                  "passfile=/nonexistent options='-c statement_timeout=15000 -c lock_timeout=12000'")
        self.handle = self.lib.PQconnectdb(target.encode())
        if self.lib.PQstatus(self.handle) != 0:
            message = self.lib.PQerrorMessage(self.handle).decode()
            self.close()
            raise RuntimeError(message)
        self.pid = self.lib.PQbackendPID(self.handle)

    def query(self, sql, parameters=None):
        if parameters is None:
            result = self.lib.PQexec(self.handle, sql.encode())
        else:
            values = (ctypes.c_char_p * len(parameters))(*[
                None if value is None else str(value).encode() for value in parameters
            ])
            result = self.lib.PQexecParams(self.handle, sql.encode(), len(parameters), None, values, None, None, 0)
        if not result:
            raise RuntimeError(self.lib.PQerrorMessage(self.handle).decode())
        try:
            if self.lib.PQresultStatus(result) not in (1, 2):
                code = self.lib.PQresultErrorField(result, ord("C"))
                message = self.lib.PQresultErrorField(result, ord("M"))
                raise DatabaseError(code.decode() if code else "", message.decode() if message else "PostgreSQL error")
            return [[None if self.lib.PQgetisnull(result, row, column) else
                     self.lib.PQgetvalue(result, row, column).decode()
                     for column in range(self.lib.PQnfields(result))]
                    for row in range(self.lib.PQntuples(result))]
        finally:
            self.lib.PQclear(result)

    def scalar(self, sql, parameters=None):
        return self.query(sql, parameters)[0][0]

    def as_person(self, person):
        self.query("reset role")
        self.query("select set_config('test.uid',$1,false)", [IDS[person]])
        self.query("set role authenticated")
        return self

    def close(self):
        if self.handle:
            self.lib.PQfinish(self.handle)
            self.handle = None


class Cluster:
    def __enter__(self):
        for executable in ["postgres", "initdb", "pg_ctl"]:
            if not (PG_BIN / executable).is_file():
                raise RuntimeError(f"Native PostgreSQL {executable} missing. Set PG_BIN_DIR to a local PostgreSQL bin directory.")
        self.directory = Path(tempfile.mkdtemp(prefix="repair-po-pg-"))
        self.data = self.directory / "data"
        self.log = self.directory / "postgres.log"
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.started = False
        try:
            subprocess.run([str(PG_BIN / "initdb"), "-D", str(self.data), "-U", "bridge_fixture",
                            "--auth-local=reject", "--auth-host=trust", "--no-locale", "--encoding=UTF8"],
                           env=ENV, check=True, capture_output=True, text=True)
            with (self.data / "postgresql.conf").open("a") as config:
                config.write(f"\nlisten_addresses='127.0.0.1'\nport={self.port}\nunix_socket_directories=''\n"
                             "max_connections=20\nshared_buffers='16MB'\nfsync=off\n"
                             "log_min_messages=warning\nlog_statement='none'\ntimezone='UTC'\n")
            subprocess.run([str(PG_BIN / "pg_ctl"), "-D", str(self.data), "-l", str(self.log), "-w", "start"],
                           env=ENV, check=True, capture_output=True, text=True)
            self.started = True
            Connection.load_libpq()
            self.admin = Connection(self, "postgres")
            self.admin.query("create role anon; create role authenticated; create role service_role;")
            print("Native server:", self.admin.scalar("select version()"), flush=True)
            print("Disposable synthetic cluster; localhost TCP only; no production connection settings used.", flush=True)
            return self
        except Exception as error:
            if isinstance(error, subprocess.CalledProcessError):
                print(error.stdout or "", error.stderr or "")
            if self.log.exists():
                print(self.log.read_text())
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if hasattr(self, "admin"):
            self.admin.close()
        if self.started or (self.data / "postmaster.pid").exists():
            subprocess.run([str(PG_BIN / "pg_ctl"), "-D", str(self.data), "-m", "immediate", "-w", "stop"],
                           env=ENV, check=True, capture_output=True, text=True)
        shutil.rmtree(self.directory)


def setup_fixture(db):
    db.query(f"""
        create schema auth;
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
        grant usage on schema auth to authenticated;
        grant execute on function auth.uid() to authenticated;
        create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);
        insert into public.areas(id,name,active) values('{AREA}','Build',true),('{OTHER_AREA}','Electrical',true);
        create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid,updated_at timestamptz default now());
        create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
    """)
    for name, identifier in IDS.items():
        role = name if name in ["admin", "mentor", "readonly"] else (
            "lead" if name in ["lead", "otherLead", "financeAdminLead"] else "student")
        db.query("insert into public.profiles values($1,$2,$3,$4,$5,now())",
                 [identifier, name, role, name != "inactive", OTHER_AREA if name == "otherLead" else AREA])
        db.query("insert into public.team_attendance_members values($1,$2,'')",
                 [identifier, "prospective" if name == "prospective" else "registered"])
    for path in [
        "supabase/migrations/202609120002_finance_v1.sql", "tests/fixtures/team_management_positions.sql",
        "supabase/migrations/202609120004_finance_notifications.sql",
        "supabase/migrations/202609190001_finance_notification_coverage.sql",
        "supabase/migrations/202609200001_finance_budget_core.sql",
    ]:
        db.query((ROOT / path).read_text())
    db.query("grant select on public.profiles to authenticated")
    db.as_person("admin")
    for name, position in [("finance", "finance_lead"), ("coach", "lead_coach_1")]:
        db.query("select public.team_manage('assign_position',$1::jsonb)",
                 [json.dumps({"user_id": IDS[name], "position_key": position, "reason": "Local fixture assignment"})])
    for name in ["financeAdmin", "financeAdminLead"]:
        db.query("select public.finance_mutate('assignment',$1::jsonb)",
                 [json.dumps({"user_id": IDS[name], "capability": "finance_admin", "active": True, "reason": "Local fixture assignment"})])
    db.query("reset role")
    db.query((ROOT / "tests/fixtures/pit_operations.sql").read_text())
    db.query(f"""
        insert into public.pit_events(id,name,start_date,end_date,status)
          values('{EVENT}','Fixture regional','2026-10-01','2026-10-03','completed');
        insert into public.pit_issues(id,event_id,title,subsystem,severity,status,description,reported_by,assigned_to) values
          ('{ISSUE}','{EVENT}','Motor repair','Drivetrain','ROBOT DOWN','REPAIRING','Replace damaged motor','{IDS['student']}','{IDS['student']}'),
          ('{OTHER_ISSUE}','{EVENT}','Electrical repair','Electrical','HIGH','DEFERRED','Inspect wiring','{IDS['student']}',null);
    """)
    db.query(MIGRATION.read_text())


class BridgeConcurrency(unittest.TestCase):
    cluster = None

    def setUp(self):
        self.database = "repair_po_fixture"
        self.cluster.admin.query(f"create database {self.database}")
        self.connections = []
        self.owner = self.connect()
        self.assertEqual(self.owner.scalar("show transaction_isolation"), "read committed")
        setup_fixture(self.owner)
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)

    def tearDown(self):
        # Release held transactions before joining waiters, including failed assertions.
        for connection in self.connections:
            self.cluster.admin.query("select pg_cancel_backend($1::int)", [connection.pid])
        self.pool.shutdown(wait=True, cancel_futures=True)
        for connection in self.connections:
            connection.close()
        self.cluster.admin.query(f"drop database {self.database}")

    def connect(self, person=None):
        connection = Connection(self.cluster, self.database)
        self.connections.append(connection)
        return connection.as_person(person) if person else connection

    def create_po(self, person="lead"):
        db = self.connect(person)
        return db.scalar("select public.finance_mutate('create',$1::jsonb)", [json.dumps({
            "area_id": AREA, "sheet_url": "https://docs.google.com/spreadsheets/d/LocalFixture/edit",
            "vendor": "Synthetic supplier", "amount": 125.50, "purpose": "Repair motor", "notes": "Private PO note",
        })])

    def stamp(self, issue=ISSUE):
        return self.owner.scalar("select updated_at::text from public.pit_issues where id=$1", [issue])

    def attach(self, db, po, expected, reason="Native fixture attachment", issue=ISSUE):
        return json.loads(db.scalar("select public.finance_attach_repair_po($1::uuid,$2::uuid,$3::timestamptz,$4::text)",
                                    [issue, po, expected, reason]))

    def links(self):
        return json.loads(self.owner.scalar("select coalesce(jsonb_agg(to_jsonb(t) order by po_id),'[]') from finance_private.repair_po_links t"))

    def snapshot(self):
        return {table: json.loads(self.owner.scalar(
            f"select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from {table} t")) for table in TABLES}

    def wait_blocked(self, waiter, blocker, future):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if future.done():
                self.fail(f"Expected a real row-lock wait; operation already ended: {future.result()}")
            blocked = self.owner.scalar("select $1::int=any(pg_blocking_pids($2::int))", [blocker.pid, waiter.pid])
            if blocked == "t":
                # Observed server-side wait, not an assumed sleep ordering.
                return
            time.sleep(0.01)
        self.fail("Did not observe the expected independent-connection row-lock barrier")

    def assert_denied(self, future):
        with self.assertRaises(DatabaseError) as failure:
            future.result(timeout=16)
        self.assertEqual(failure.exception.code, "42501")
        self.assertEqual(str(failure.exception), "Repair purchasing details unavailable")

    def wait_at(self, po, target="issue", person="lead", expected=None):
        blocker, waiter = self.connect(), self.connect(person)
        blocker.query("begin")
        if target == "issue":
            blocker.query("select id from public.pit_issues where id=$1 for update", [ISSUE])
        else:
            blocker.query("select id from public.finance_purchase_orders where id=$1 for update", [po])
        future = self.pool.submit(self.attach, waiter, po, expected or self.stamp())
        self.wait_blocked(waiter, blocker, future)
        return blocker, waiter, future

    def test_same_pair_replay_preserves_first_audit_and_has_no_side_effects(self):
        po, stamp = self.create_po(), self.stamp()
        first, second = self.connect("lead"), self.connect("admin")
        before = self.snapshot()
        first.query("begin")
        first_context = self.attach(first, po, stamp, "First audit")
        self.assertEqual(len(first_context["links"]), 1)
        pending = self.pool.submit(self.attach, second, po, stamp, "Replay must not replace audit")
        self.wait_blocked(second, first, pending)
        first.query("commit")
        self.assertEqual(len(pending.result(timeout=16)["links"]), 1)
        links = self.links()
        self.assertEqual(len(links), 1)
        self.assertEqual((links[0]["reason"], links[0]["linked_by"]), ("First audit", IDS["lead"]))
        self.assertEqual(links[0]["linked_at"], first_context["links"][0]["linked_at"])
        self.assertEqual(links[0]["issue_updated_at"], first_context["issue_updated_at"])
        self.assertEqual(self.snapshot(), before)

    def test_distinct_links_serialize_on_same_repair(self):
        first_po, second_po, stamp = self.create_po(), self.create_po(), self.stamp()
        first, second = self.connect("lead"), self.connect("lead")
        before = self.snapshot()
        first.query("begin")
        self.attach(first, first_po, stamp)
        pending = self.pool.submit(self.attach, second, second_po, stamp)
        self.wait_blocked(second, first, pending)
        first.query("commit")
        self.assertEqual(len(pending.result(timeout=16)["links"]), 2)
        self.assertEqual({link["po_id"] for link in self.links()}, {first_po, second_po})
        self.assertEqual(self.snapshot(), before)

    def test_stale_repair_update_committed_while_attach_waits_is_rejected(self):
        po, stamp = self.create_po(), self.stamp()
        updater, waiter = self.connect("lead"), self.connect("lead")
        updater.query("begin")
        updater.query("select public.pit_update_issue($1::jsonb)", [json.dumps({
            "id": ISSUE, "expected_updated_at": stamp, "repair_notes": "Concurrent repair update",
        })])
        pending = self.pool.submit(self.attach, waiter, po, stamp)
        self.wait_blocked(waiter, updater, pending)
        updater.query("commit")
        after_update = self.snapshot()
        with self.assertRaises(DatabaseError) as failure:
            pending.result(timeout=16)
        self.assertEqual(failure.exception.code, "40001")
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), after_update)

    def test_rollback_removes_uncommitted_link_and_releases_waiting_attacher(self):
        po, stamp = self.create_po(), self.stamp()
        first, second = self.connect("lead"), self.connect("admin")
        before = self.snapshot()
        first.query("begin")
        self.attach(first, po, stamp, "Rolled back audit")
        self.assertEqual(self.links(), [])
        pending = self.pool.submit(self.attach, second, po, stamp, "Surviving audit")
        self.wait_blocked(second, first, pending)
        first.query("rollback")
        self.assertEqual(len(pending.result(timeout=16)["links"]), 1)
        links = self.links()
        self.assertEqual(len(links), 1)
        self.assertEqual((links[0]["reason"], links[0]["linked_by"]), ("Surviving audit", IDS["admin"]))
        self.assertEqual(self.snapshot(), before)

    def test_repair_role_revocation_during_repair_lock_wait_is_rechecked(self):
        po = self.create_po()
        blocker, _, pending = self.wait_at(po)
        self.owner.query("update public.profiles set role='student' where id=$1", [IDS["lead"]])
        before = self.snapshot()
        blocker.query("commit")
        self.assert_denied(pending)
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), before)

    def test_repair_role_revocation_during_po_lock_wait_is_rechecked(self):
        po = self.create_po()
        blocker, _, pending = self.wait_at(po, "po")
        self.owner.query("update public.profiles set role='student' where id=$1", [IDS["lead"]])
        before = self.snapshot()
        blocker.query("commit")
        self.assert_denied(pending)
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), before)

    def test_inactive_caller_during_po_wait_leaves_no_partial_link(self):
        po = self.create_po()
        blocker, _, pending = self.wait_at(po, "po")
        self.owner.query("update public.profiles set active=false where id=$1", [IDS["lead"]])
        before = self.snapshot()
        blocker.query("commit")
        self.assert_denied(pending)
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), before)

    def test_finance_admin_revocation_during_po_wait_is_rechecked(self):
        po = self.create_po("student")
        blocker, _, pending = self.wait_at(po, "po", "financeAdminLead")
        self.owner.query("update public.finance_assignments set active=false where user_id=$1 and capability='finance_admin'", [IDS["financeAdminLead"]])
        before = self.snapshot()
        blocker.query("commit")
        self.assert_denied(pending)
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), before)

    def test_po_ownership_and_visibility_loss_during_wait_is_rechecked(self):
        po = self.create_po()
        blocker, _, pending = self.wait_at(po, "po")
        blocker.query("update public.finance_purchase_orders set requester_id=$1 where id=$2", [IDS["student"], po])
        blocker.query("commit")
        before = self.snapshot()
        self.assert_denied(pending)
        self.assertEqual(self.links(), [])
        self.assertEqual(self.snapshot(), before)

    def test_replay_after_role_revocation_is_denied_and_preserves_existing_audit(self):
        po, stamp = self.create_po(), self.stamp()
        self.attach(self.connect("lead"), po, stamp)
        audit = self.links()
        blocker, _, pending = self.wait_at(po)
        self.owner.query("update public.profiles set role='student' where id=$1", [IDS["lead"]])
        before = self.snapshot()
        blocker.query("commit")
        self.assert_denied(pending)
        self.assertEqual(self.links(), audit)
        self.assertEqual(self.snapshot(), before)

    def test_read_boundaries_and_private_table_denial_on_native_postgres(self):
        po, other = self.create_po("student"), self.create_po("other")
        admin = self.connect("admin")
        self.attach(admin, po, self.stamp())
        self.attach(admin, other, self.stamp())
        student = self.connect("student")
        context = json.loads(student.scalar("select public.finance_repair_context($1::uuid)", [ISSUE]))
        self.assertEqual([link["po_id"] for link in context["links"]], [po])
        self.assertEqual(set(context["links"][0]), {"po_id", "po_number", "status", "requester_name", "linked_at"})
        for sql in ["select * from finance_private.repair_po_links", "delete from finance_private.repair_po_links"]:
            with self.assertRaises(DatabaseError) as failure:
                student.query(sql)
            self.assertEqual(failure.exception.code, "42501")
        student.query("reset role; set role anon")
        with self.assertRaises(DatabaseError) as failure:
            student.query("select public.finance_repair_context($1::uuid)", [ISSUE])
        self.assertEqual(failure.exception.code, "42501")

    def test_exact_native_grants_and_repair_editor_role_boundary(self):
        self.assertEqual(self.owner.scalar("select relrowsecurity from pg_class where oid='finance_private.repair_po_links'::regclass"), "t")
        for role in ["anon", "authenticated", "service_role"]:
            self.assertEqual(self.owner.scalar("select has_table_privilege($1,'finance_private.repair_po_links','select,insert,update,delete')", [role]), "f")
        for signature in ["public.finance_repair_context(uuid)", "public.finance_repair_po_candidate(uuid,uuid)",
                          "public.finance_attach_repair_po(uuid,uuid,timestamptz,text)"]:
            self.assertEqual(self.owner.scalar("select has_function_privilege('anon',$1,'execute')", [signature]), "f")
            self.assertEqual(self.owner.scalar("select has_function_privilege('authenticated',$1,'execute')", [signature]), "t")
        po = self.create_po("student")
        for person in ["student", "financeAdmin", "readonly", "inactive", "prospective"]:
            with self.assertRaises(DatabaseError) as failure:
                self.attach(self.connect(person), po, self.stamp())
            self.assertEqual(failure.exception.code, "42501")
            self.assertEqual(str(failure.exception), "Repair purchasing details unavailable")
        self.assertEqual(self.links(), [])

    def test_approved_po_budget_and_notification_rows_are_unchanged(self):
        po = self.create_po("student")
        for person, action, patch in [
            ("student", "submit", {}), ("finance", "approve", {"slot": "finance_approver"}),
            ("coach", "approve", {"slot": "po_approver"}),
        ]:
            db = self.connect(person)
            version = int(db.scalar("select version from public.finance_purchase_orders where id=$1", [po]))
            db.query("select public.finance_mutate($1,$2::jsonb)", [action, json.dumps({"id": po, "version": version, **patch})])
        self.owner.query(f"""
            insert into public.finance_seasons(id,name,status,starting_funds,reserve_target,created_by)
              values('{uid(500)}','Fixture budget','active',1000,100,'{IDS['admin']}');
            insert into public.finance_budget_categories(id,season_id,name,allocation)
              values('{uid(501)}','{uid(500)}','Parts',500);
            insert into public.finance_po_budget(po_id,season_id,category_id)
              values('{po}','{uid(500)}','{uid(501)}');
        """)
        before = self.snapshot()
        for table in ["public.finance_po_approvals", "public.finance_po_revisions", "finance_private.history",
                      "public.finance_seasons", "public.finance_po_budget", "public.team_notifications"]:
            self.assertGreater(len(before[table]), 0, table)
        first, second = self.connect("admin"), self.connect("mentor")
        stamp = self.stamp()
        first.query("begin")
        self.attach(first, po, stamp)
        pending = self.pool.submit(self.attach, second, po, stamp)
        self.wait_blocked(second, first, pending)
        first.query("commit")
        self.assertEqual(len(pending.result(timeout=16)["links"]), 1)
        self.assertEqual(len(self.links()), 1)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    with Cluster() as cluster:
        BridgeConcurrency.cluster = cluster
        result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result.wasSuccessful() else 1)
