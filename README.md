# Orbe Bot 🤖

Bot de WhatsApp para Orbe - gestión de finanzas personales por chat.

## Lo que puede hacer

- 💸 Registrar gastos: *"gasté $5000 en supermercado"*
- 💰 Registrar ingresos: *"cobré el sueldo $200000"*
- 📊 Ver balance: *"balance"* o *"cómo voy este mes"*
- 🕐 Últimas transacciones: *"últimas transacciones"*
- 🎯 Ver presupuesto: *"presupuesto"*
- 🐷 Ver ahorros: *"ahorros"*
- 💳 Ver deudas: *"deudas"*
- ⚠️ Ver vencimientos: *"vencimientos"* o *"qué facturas hay que pagar"*
- 📅 Agregar evento: *"en 2 semanas hay que pagar kinesiología"*
- 🌟 Resumen general: *"resumen"*

## Deploy en Railway

1. Subí este proyecto a un repo de GitHub (sin el .env)
2. En railway.app → New Project → Deploy from GitHub
3. Agregá las variables de entorno (copiá el contenido del .env)
4. Railway te da una URL pública, copiala

## Configurar Twilio webhook

1. En Twilio → Messaging → Try it out → Send a WhatsApp message
2. Clic en **Sandbox Settings**
3. En *"When a message comes in"* pegá: `https://TU-URL-RAILWAY.up.railway.app/webhook`
4. Método: HTTP POST
5. Guardar

## Variables de entorno necesarias

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
SUPABASE_URL=
SUPABASE_ANON_KEY=
ANTHROPIC_API_KEY=
USER_ID=
PORT=3000
```
