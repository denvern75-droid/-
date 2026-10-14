@echo off
REM 윈도우 단일 실행파일(.exe) 빌드 스크립트
REM 사전 준비: Python 3.11 이상 설치
python -m pip install -r requirements.txt pyinstaller
pyinstaller --onefile --noconsole --name TextAction run_textaction.py
echo.
echo 빌드 완료: dist\TextAction.exe
pause
