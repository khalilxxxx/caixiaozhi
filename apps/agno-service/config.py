from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / '.env')
DATA_DIR = Path(os.getenv('AGNO_DATA_DIR', str(ROOT / '.runtime' / 'agno-local'))).resolve()
MODEL = os.getenv('AGNO_MODEL') or os.getenv('DSH_MODEL') or 'deepseek-chat'
API_KEY = os.getenv('AGNO_API_KEY') or os.getenv('DSH_API_KEY') or ''
BASE_URL = os.getenv('AGNO_BASE_URL') or os.getenv('DSH_BASE_URL') or 'https://api.deepseek.com/v1'
PORT = int(os.getenv('AGNO_PORT', '5191'))
ALLOWED_ORIGINS = {'http://127.0.0.1:5190', 'http://localhost:5190', f'http://127.0.0.1:{PORT}'}
MAX_FILE_BYTES = 10 * 1024 * 1024
