@echo off
rem Runs deploy\prod.ps1 without changing the PowerShell execution policy. Usage: deploy\prod.cmd help
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prod.ps1" %*
