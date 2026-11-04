#!/usr/bin/env python3
"""Capture current upstream forecasts and publish only recorded observations."""
import json
from pathlib import Path
import collector
collector.init()
if not collector.update():
    raise RuntimeError(collector.STATUS.get('error') or 'Weather update failed')
Path('docs/weather.json').write_text(json.dumps(collector.payload(), separators=(',', ':'))+'\n')
