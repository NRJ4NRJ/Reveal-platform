# Daily Pulse

Daily Pulse collects recent French renewable energy news, builds an HTML digest, and can either send the email or generate a preview locally.

## Files

- `daily_pulse.py`: main script
- `run_daily_pulse.ps1`: PowerShell launcher that writes execution logs
- `Mail Template/`: email assets and template helpers
- `daily_pulse_blueprint.json`: source blueprint data
- `config.example.py`: sample SMTP configuration

## Setup

1. Copy `config.example.py` to `config.py`.
2. Fill in the SMTP credentials and optional CC list.
3. Install the required Python packages, including `feedparser` and `Pillow`.

## Usage

```powershell
python daily_pulse.py --preview
python daily_pulse.py
```

## GitHub Actions schedule

The repository includes a workflow at `.github/workflows/daily-pulse.yml` that can send the digest automatically every morning at `09:10` in the `Europe/Paris` timezone.

Add these repository secrets before enabling it:

- `DAILY_PULSE_SENDER_EMAIL`
- `DAILY_PULSE_SENDER_PASS`
- `DAILY_PULSE_SMTP_SERVER`
- `DAILY_PULSE_SMTP_PORT`
- `DAILY_PULSE_RECIPIENT`
- `DAILY_PULSE_CC_EMAILS`

`DAILY_PULSE_CC_EMAILS` should be a comma-separated list. The workflow runs twice in UTC and only sends when the local Paris time is exactly `09:10`, so it stays correct through daylight-saving changes.
