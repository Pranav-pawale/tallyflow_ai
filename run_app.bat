@echo off
title TallyFlow AI Launcher
echo ========================================================
echo               TallyFlow AI - Starting...
echo ========================================================
echo Launching Web Interface in default browser...
start http://localhost:8501
echo Starting Streamlit server...
cd backend
python -m streamlit run app.py --server.headless true
pause
