"""Fixed public JSON used as realistic test data; never the local fetcher output."""
from pathlib import Path

# Same layout as the published site's data/ directory. The frontend tests read
# the same files (frontend/src/test-data.js), so keep the two in step.
PUBLIC_DATA = Path(__file__).resolve().parent / 'fixtures' / 'public-data'
