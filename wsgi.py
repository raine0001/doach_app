import sys
import os
from pathlib import Path
from app import application 

BASE = str(Path(__file__).resolve().parent.parent)
APPDIR = os.path.join(BASE, "doach")             
if APPDIR not in sys.path:
    sys.path.insert(0, APPDIR)





