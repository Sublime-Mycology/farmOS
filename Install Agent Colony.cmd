@echo off
title Install Agent Colony and Clip Factory
echo Installing Agent Colony and Clip Factory. Click Yes if Windows asks for permission.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://raw.githubusercontent.com/Sublime-Mycology/farmOS/clip-factory/setup-windows.ps1 | iex"
echo.
echo If you see red error text above, send Claude the file: %USERPROFILE%\ClipFactory\setup-log.txt
pause
