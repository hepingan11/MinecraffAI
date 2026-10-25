@echo off
chcp 65001 >nul
node "%~dp0minecraft-chat-bridge.mjs" %*
