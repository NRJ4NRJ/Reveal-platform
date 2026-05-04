"""Builds dolfines_email_template.html with banner image embedded as base64."""
import base64, pathlib

HERE   = pathlib.Path(__file__).parent
banner = HERE / "Bandeau Page.jpg"
out    = HERE / "dolfines_email_template.html"

with open(banner, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

img_src = f"data:image/jpeg;base64,{b64}"

html = f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Dolfines — Email Template</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f9; font-family:'Trebuchet MS',Arial,sans-serif;">

<!-- ═══════════════════════════════════════════════════════════
     OUTER WRAPPER
════════════════════════════════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f4f6f9; padding:32px 0;">
<tr><td align="center" valign="top">

  <!-- INNER CARD — max 600px -->
  <table width="600" cellpadding="0" cellspacing="0" border="0"
         style="max-width:600px; width:100%; background:#ffffff;
                border-radius:6px; overflow:hidden;
                box-shadow:0 4px 20px rgba(0,0,0,0.10);">


    <!-- ─────────────────────────────────────────────────
         HEADER BANNER
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:0; margin:0; line-height:0;">
        <img src="{img_src}"
             alt="Dolfines — Experts in Operational Excellence"
             width="600"
             style="display:block; width:100%; max-width:600px;
                    height:auto; border:0; outline:none;">
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         YELLOW ACCENT BAR
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="background:#F5C518; height:4px; font-size:0; line-height:0;">&nbsp;</td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         GREETING
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:36px 48px 0 48px;">
        <!-- EDITABLE: salutation -->
        <p style="margin:0 0 4px 0; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:15px; color:#1a1a2e; font-weight:bold;">
          Dear [First Name],
        </p>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         HERO HEADLINE
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:24px 48px 0 48px;">
        <!-- EDITABLE: main headline -->
        <h1 style="margin:0 0 10px 0; font-family:Georgia,'Times New Roman',serif;
                   font-size:26px; line-height:1.3; color:#1a1a2e;
                   font-weight:bold; letter-spacing:-0.3px;">
          Powering Tomorrow&#8217;s Operations Today
        </h1>
        <!-- EDITABLE: subheadline -->
        <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:13px; color:#4a6fa5; font-weight:bold;
                  letter-spacing:0.5px; text-transform:uppercase;">
          Independent Expert Services &nbsp;&middot;&nbsp; Solar &amp; Wind &nbsp;&middot;&nbsp; Asset Performance
        </p>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         BODY TEXT
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:24px 48px 0 48px;">

        <!-- EDITABLE: paragraph 1 -->
        <p style="margin:0 0 16px 0; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:14px; line-height:1.75; color:#333344;">
          At Dolfines, we provide independent technical advisory and operational excellence
          services to renewable energy asset owners, developers, and investors across the
          full project lifecycle &#8212; from early-stage feasibility through construction
          and long-term operations.
        </p>

        <!-- EDITABLE: paragraph 2 -->
        <p style="margin:0 0 16px 0; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:14px; line-height:1.75; color:#333344;">
          Our team of engineers and energy specialists combines deep sector knowledge
          with rigorous, data-driven methodologies to help you maximise the performance,
          reliability, and value of your renewable energy portfolio.
        </p>

        <!-- EDITABLE: paragraph 3 -->
        <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:14px; line-height:1.75; color:#333344;">
          Whether you require long-term wind or solar resource analysis, technical due
          diligence, owner&#8217;s engineering, or ongoing asset management support,
          Dolfines delivers independent expertise you can rely on.
        </p>

      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         DIVIDER
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:32px 48px 0 48px;">
        <hr style="border:none; border-top:1px solid #e0e4ea; margin:0;">
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         FEATURE CARDS (3 columns)
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:32px 48px 0 48px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>

            <!-- Card 1 -->
            <td width="33%" valign="top" style="padding:0 8px 0 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#f4f6f9; border-radius:6px;
                             border-top:3px solid #F5C518; padding:20px 14px;
                             text-align:center;">
                    <!-- EDITABLE: card 1 icon -->
                    <div style="font-size:26px; margin-bottom:10px;">&#9728;&#65039;</div>
                    <!-- EDITABLE: card 1 title -->
                    <p style="margin:0 0 8px 0; font-family:Georgia,serif;
                              font-size:13px; font-weight:bold; color:#1a1a2e;">
                      Solar Solutions
                    </p>
                    <!-- EDITABLE: card 1 body -->
                    <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                              font-size:12px; line-height:1.65; color:#555566;">
                      Resource assessment, yield analysis, technical due diligence,
                      and performance monitoring for utility-scale PV.
                    </p>
                  </td>
                </tr>
              </table>
            </td>

            <!-- Card 2 -->
            <td width="33%" valign="top" style="padding:0 4px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#f4f6f9; border-radius:6px;
                             border-top:3px solid #F5C518; padding:20px 14px;
                             text-align:center;">
                    <!-- EDITABLE: card 2 icon -->
                    <div style="font-size:26px; margin-bottom:10px;">&#127788;&#65039;</div>
                    <!-- EDITABLE: card 2 title -->
                    <p style="margin:0 0 8px 0; font-family:Georgia,serif;
                              font-size:13px; font-weight:bold; color:#1a1a2e;">
                      Wind Energy
                    </p>
                    <!-- EDITABLE: card 2 body -->
                    <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                              font-size:12px; line-height:1.65; color:#555566;">
                      Long-term wind analysis, MCP studies, turbine selection, and
                      SCADA data review for onshore wind farms.
                    </p>
                  </td>
                </tr>
              </table>
            </td>

            <!-- Card 3 -->
            <td width="33%" valign="top" style="padding:0 0 0 8px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#f4f6f9; border-radius:6px;
                             border-top:3px solid #F5C518; padding:20px 14px;
                             text-align:center;">
                    <!-- EDITABLE: card 3 icon -->
                    <div style="font-size:26px; margin-bottom:10px;">&#9881;&#65039;</div>
                    <!-- EDITABLE: card 3 title -->
                    <p style="margin:0 0 8px 0; font-family:Georgia,serif;
                              font-size:13px; font-weight:bold; color:#1a1a2e;">
                      Operational Excellence
                    </p>
                    <!-- EDITABLE: card 3 body -->
                    <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                              font-size:12px; line-height:1.65; color:#555566;">
                      Owner&#8217;s engineering, O&amp;M contract review, KPI
                      benchmarking, and independent asset management.
                    </p>
                  </td>
                </tr>
              </table>
            </td>

          </tr>
        </table>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         CTA BUTTON
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:40px 48px 0 48px; text-align:center;">
        <!-- EDITABLE: CTA button text and URL -->
        <a href="https://www.dolfines.com"
           target="_blank" rel="noopener noreferrer"
           style="display:inline-block; background:#F5C518; color:#1a1a2e;
                  font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:14px; font-weight:bold; text-decoration:none;
                  padding:14px 38px; border-radius:30px;
                  letter-spacing:0.5px;">
          Discover Our Solutions &nbsp;&rarr;
        </a>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         CONTACT STRIP
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:40px 48px 0 48px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background:#1a1a2e; border-radius:6px; padding:22px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <!-- EDITABLE: sender name -->
                    <p style="margin:0 0 2px 0; font-family:Georgia,serif;
                              font-size:14px; font-weight:bold; color:#F5C518;">
                      [Sender Name]
                    </p>
                    <!-- EDITABLE: sender role -->
                    <p style="margin:0 0 10px 0; font-family:'Trebuchet MS',Arial,sans-serif;
                              font-size:12px; color:#93b4d0;">
                      [Role] &nbsp;&middot;&nbsp; Dolfines
                    </p>
                    <!-- EDITABLE: contact details -->
                    <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                              font-size:12px; color:#aabccc; line-height:1.8;">
                      &#9993;&nbsp;
                      <a href="mailto:[email@dolfines.com]"
                         style="color:#aabccc; text-decoration:none;">
                        [email@dolfines.com]
                      </a><br>
                      &#128222;&nbsp; [+33 X XX XX XX XX]<br>
                      &#127760;&nbsp;
                      <a href="https://www.dolfines.com"
                         style="color:#F5C518; text-decoration:none;">
                        www.dolfines.com
                      </a>
                    </p>
                  </td>
                  <td align="right" valign="middle" style="padding-left:20px;">
                    <!-- EDITABLE: replace this placeholder with a hosted Dolfines logo <img> -->
                    <div style="width:84px; height:42px; background:#F5C518;
                                border-radius:4px; text-align:center; line-height:42px;">
                      <span style="font-family:Georgia,serif; font-size:11px;
                                   font-weight:bold; color:#1a1a2e; letter-spacing:1px;">
                        DOLFINES
                      </span>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         SOCIAL LINKS
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:28px 48px 0 48px; text-align:center;">
        <!-- EDITABLE: social URLs -->
        <a href="https://www.linkedin.com/company/dolfines"
           target="_blank" rel="noopener noreferrer"
           style="display:inline-block; margin:0 5px; background:#1a1a2e;
                  color:#ffffff; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:11px; font-weight:bold; text-decoration:none;
                  padding:7px 18px; border-radius:20px;">
          in&nbsp; LinkedIn
        </a>
        <a href="https://www.dolfines.com"
           target="_blank" rel="noopener noreferrer"
           style="display:inline-block; margin:0 5px; background:#1a1a2e;
                  color:#ffffff; font-family:'Trebuchet MS',Arial,sans-serif;
                  font-size:11px; font-weight:bold; text-decoration:none;
                  padding:7px 18px; border-radius:20px;">
          &#127760;&nbsp; Website
        </a>
      </td>
    </tr>


    <!-- ─────────────────────────────────────────────────
         FOOTER
    ───────────────────────────────────────────────── -->
    <tr>
      <td style="padding:28px 48px 36px 48px; text-align:center;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="border-top:1px solid #e0e4ea; padding-top:24px;">

            <!-- EDITABLE: company address -->
            <p style="margin:0 0 8px 0; font-family:'Trebuchet MS',Arial,sans-serif;
                      font-size:10.5px; color:#9ca3af; line-height:1.7;">
              Dolfines SAS &nbsp;&middot;&nbsp; [Company Address] &nbsp;&middot;&nbsp; France
            </p>
            <!-- EDITABLE: unsubscribe and privacy links -->
            <p style="margin:0; font-family:'Trebuchet MS',Arial,sans-serif;
                      font-size:10.5px; color:#9ca3af;">
              <a href="[unsubscribe_link]"
                 style="color:#4a6fa5; text-decoration:underline;">
                Unsubscribe
              </a>
              &nbsp;&nbsp;|&nbsp;&nbsp;
              <a href="[privacy_policy_link]"
                 style="color:#4a6fa5; text-decoration:underline;">
                Privacy Policy
              </a>
            </p>

          </td></tr>
        </table>
      </td>
    </tr>


  </table>
  <!-- /inner card -->

</td></tr>
</table>
<!-- /outer wrapper -->

</body>
</html>"""

out.write_text(html, encoding="utf-8")
print(f"Template written: {out}")
print(f"File size: {out.stat().st_size / 1024:.1f} KB")
