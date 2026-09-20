"""Rebuild the data-free browser template: pip install XlsxWriter==3.2.9.
Native charts are authored by XlsxWriter; xlsx-populate fills cells/named ranges.
No runtime Python, handcrafted OOXML, macros, external links or financial data.
"""
from pathlib import Path
from datetime import datetime
import xlsxwriter
out = Path(__file__).resolve().parents[1] / 'public' / 'finance-workbook.xlsx'
out.parent.mkdir(exist_ok=True)
w = xlsxwriter.Workbook(out)
w.set_properties({'title':'FRC Team 4418 · IMPULSE Finance','author':'FRC Team 4418', 'created':datetime(2026,9,20)})
navy='#182C47'; teal='#117C83'; gold='#C6932B'
title=w.add_format({'font_name':'Calibri','font_size':20,'bold':True,'font_color':navy})
sub=w.add_format({'font_name':'Calibri','font_size':10,'font_color':'#526277'})
header=w.add_format({'font_name':'Calibri','font_size':11,'bold':True,'bg_color':navy,'font_color':'white','text_wrap':True,'valign':'vcenter'})
names=['Executive Summary','Budget','Purchase Orders','Income','Expenses & Credits','Budget History','PO History']
headers=[[],['Category','Description','Allocation','Restricted Received','Funded Allocation','Forecast','Requested','Committed','Gross Spent','Credits','Net Spent','Available','% Used','Active / Archived'],['PO #','Vendor','Purpose','Requester','Functional Area','Budget Category','Amount','Revision','Status','Current Budget Bucket','Lead Coach Approval','Finance Lead Approval','Submitted Date (UTC)','Approved Date (UTC)','School Submitted Date (UTC)','School Reference','Last Updated (UTC)'],['Source / Sponsor','Type','Status','Amount','Expected Date','Received Date','Restricted To','Reference','Notes','Created By','Created At (UTC)','Updated At (UTC)'],['Type','Date','Category','Vendor / Payee','Amount','Related PO','Reference','Notes / Reason','Entered By','Created At (UTC)'],['Timestamp (UTC)','Actor','Action','Season','Category','Related PO','Before','After','Amount / Delta','Reason'],['Timestamp (UTC)','PO','Actor','Action','Revision','Explanation']]
for name,cols in zip(names,headers):
 s=w.add_worksheet(name);s.hide_gridlines(2);s.set_zoom(90)
 s.set_column(0,(len(cols)-1 if cols else 9),20)
 s.merge_range(0,0,0,(len(cols)-1 if cols else 9),name,title)
 s.merge_range(1,0,1,(len(cols)-1 if cols else 9),'FRC Team 4418 · IMPULSE',sub)
 s.freeze_panes(4,0);s.repeat_rows(0,3);s.set_landscape();s.set_paper(9);s.fit_to_pages(1,0)
 s.set_margins(.3,.3,.5,.5);s.set_footer('&LIMPULSE · Finance &RPage &P of &N');s.set_row(0,30);s.set_row(3,32)
 if cols:s.write_row(3,0,cols,header)
summary=w.worksheets()[0];summary.set_column('A:J',12);summary.set_column('P:AD',18,None,{'hidden':True})
# Named ranges are rebound to the exact populated ranges at export; no row limits.
for key,col in [('Categories','P'),('Spent','Q'),('Committed','R'),('Requested','S'),('Remaining','T'),('Months','V'),('MonthlySpending','W'),('FundingLabels','Y'),('FundingValues','Z')]:
 w.define_name("'Executive Summary'!Export"+key,"='Executive Summary'!$%s$2:$%s$2"%(col,col))
chart=w.add_chart({'type':'bar','subtype':'stacked'})
for key,color in [('Spent',navy),('Committed',teal),('Requested',gold),('Remaining','#D9E8E7')]:
 chart.add_series({'categories_data':[], 'values_data':[], 'name':key,'categories':"='Executive Summary'!ExportCategories",'values':"='Executive Summary'!Export"+key,'fill':{'color':color},'border':{'none':True}})
chart.set_title({'name':'Category funding · net spending and remaining'})
chart.set_x_axis({'num_format':'$#,##0'});chart.set_y_axis({'reverse':True});chart.set_legend({'position':'bottom'})
chart.show_hidden_data();chart.set_size({'width':850,'height':340});summary.insert_chart('A22',chart)
chart=w.add_chart({'type':'column'})
chart.add_series({'categories_data':[], 'values_data':[], 'name':'Net spending','categories':"='Executive Summary'!ExportMonths",'values':"='Executive Summary'!ExportMonthlySpending",'fill':{'color':teal},'border':{'none':True}})
chart.set_title({'name':'Dated net spending · excludes undated / future activity'});chart.set_y_axis({'num_format':'$#,##0'});chart.set_legend({'none':True});chart.show_hidden_data();chart.set_size({'width':850,'height':300});summary.insert_chart('A41',chart)
chart=w.add_chart({'type':'column'})
chart.add_series({'categories_data':[], 'values_data':[], 'name':'Funding','categories':"='Executive Summary'!ExportFundingLabels",'values':"='Executive Summary'!ExportFundingValues",'points':[{'fill':{'color':navy}},{'fill':{'color':teal}},{'fill':{'color':gold}}]})
chart.set_title({'name':'Funding · expected is planning only'});chart.set_y_axis({'num_format':'$#,##0'});chart.set_legend({'none':True});chart.show_hidden_data();chart.set_size({'width':850,'height':300});summary.insert_chart('A58',chart)
summary.print_area('A1:J74')
negative=w.add_format({'font_color':'#9C2434','bg_color':'#FCE8EB'})
near=w.add_format({'font_color':'#825A0A','bg_color':'#FFF2D3'})
b=w.worksheets()[1]
b.conditional_format('L5:L1048576',{'type':'cell','criteria':'<','value':0,'format':negative})
b.conditional_format('M5:M1048576',{'type':'cell','criteria':'>=','value':.9,'format':near})
w.close()
