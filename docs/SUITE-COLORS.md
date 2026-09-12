# Team 4418 suite colors

Source inspected: https://www.frc4418.org/ and /files/main_style.css, 2026-09-12.
The current official IMPULSE logo assets are white. The public stylesheet uses #171717, #FBFBFB, #D5D5D5, blue #0099FF and red #D16257.
Blue #006BB3 (70% of the source blue) is the accessible interactive color; hover #00568F is darker. Red #9C493F is a darker source-red variant for readable urgent text. The source colors remain named brand tokens, not small text on white.
Yellow warning colors #FBF3DF / #80651F / #E9DCBA are retained from existing Inventory warning styles; no official yellow value was found in the site's current monochrome assets. Success green #28623C / #EDF3E8 is reserved for positive operational states.

All three apps carry identical src/suite-colors.css. Existing typography, spacing, radii and layout remain unchanged. Structural green has become neutral; interactive selections, links and focus rings use blue. Destructive/urgent/error states use red; late/attention/low-stock use yellow; ready/success stays green. State labels remain present, so color is not the sole indicator.

Document theme and existing white-rocket app icons use official dark #171717. No auth, database, role, workflow or API code changed.

Verified contrast ratios: white/primary 5.59:1; blue/info surface 5.03:1; danger pair 5.20:1; warning pair 5.00:1; success pair 6.40:1; muted/background 6.08:1. Input boundary #8C8C8C on white: 3.36:1. This is a targeted color-pair check, not a full accessibility certification.
