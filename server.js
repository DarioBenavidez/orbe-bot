require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Clientes ───────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── Supabase helpers ───────────────────────────────────────
async function loadData(uid) {
  const { data, error } = await supabase
    .from('finanzas')
    .select('data')
    .eq('id', uid)
    .single();
  if (error || !data) return null;
  return data.data;
}

async function saveData(uid, payload) {
  await supabase
    .from('finanzas')
    .upsert({ id: uid, data: payload, updated_at: new Date().toISOString() });
}

// ── Fecha helpers ──────────────────────────────────────────
function today() {
  const now = new Date();
  // Ajuste zona horaria Argentina (UTC-3)
  const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().split('T')[0];
}

function currentMonth() {
  const now = new Date();
  const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return { month: ar.getMonth(), year: ar.getFullYear() };
}

function parseDateParts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

function fmt(n) {
  return '$' + Math.abs(Number(n)).toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// ── Procesamiento de acciones ──────────────────────────────
async function processAction(action, data) {
  const { month, year } = currentMonth();

  switch (action.type) {

    case 'agregar_transaccion': {
      const tx = {
        id: Date.now().toString(),
        type: action.txType || 'gasto', // gasto | ingreso | sueldo
        description: action.description,
        amount: parseFloat(action.amount),
        category: action.category || 'Otros',
        date: action.date || today(),
        savingsId: '',
      };
      const newData = { ...data, transactions: [...data.transactions, tx] };
      await saveData(process.env.USER_ID, newData);
      const emoji = tx.type === 'gasto' ? '💸' : '💰';
      return `${emoji} *${tx.type === 'gasto' ? 'Gasto' : tx.type === 'sueldo' ? 'Sueldo' : 'Ingreso'} registrado*\n\n📝 ${tx.description}\n💵 ${fmt(tx.amount)}\n📅 ${tx.date}`;
    }

    case 'consultar_balance': {
      const txs = data.transactions.filter(t => {
        const { month: m, year: y } = parseDateParts(t.date);
        return m === month && y === year;
      });
      const ingresos = txs.filter(t => t.type === 'ingreso' || t.type === 'sueldo').reduce((a, t) => a + t.amount, 0);
      const gastos = txs.filter(t => t.type === 'gasto').reduce((a, t) => a + t.amount, 0);
      const balance = ingresos - gastos;
      return `📊 *Balance de ${MONTH_NAMES[month]} ${year}*\n\n💰 Ingresos: ${fmt(ingresos)}\n💸 Gastos: ${fmt(gastos)}\n${balance >= 0 ? '✅' : '⚠️'} Balance: ${fmt(balance)}`;
    }

    case 'ultimas_transacciones': {
      const txs = data.transactions.filter(t => {
        const { month: m, year: y } = parseDateParts(t.date);
        return m === month && y === year;
      }).slice(-5).reverse();
      if (txs.length === 0) return '📭 No hay transacciones este mes.';
      const lista = txs.map(t =>
        `${t.type === 'gasto' ? '💸' : '💰'} ${t.description} — ${fmt(t.amount)} (${t.date})`
      ).join('\n');
      return `🕐 *Últimas transacciones*\n\n${lista}`;
    }

    case 'consultar_presupuesto': {
      const txs = data.transactions.filter(t => {
        const { month: m, year: y } = parseDateParts(t.date);
        return m === month && y === year && t.type === 'gasto';
      });
      const expByCat = txs.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + t.amount; return acc; }, {});
      const cats = data.categories || {};
      const lines = data.budgets
        .filter(b => b.limit > 0)
        .map(b => {
          const spent = expByCat[b.cat] || 0;
          const pct = Math.round((spent / b.limit) * 100);
          const bar = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
          return `${bar} ${cats[b.cat] || '📦'} ${b.cat}: ${fmt(spent)} / ${fmt(b.limit)} (${pct}%)`;
        });
      if (lines.length === 0) return '📭 No tenés presupuestos configurados.';
      return `🎯 *Presupuesto ${MONTH_NAMES[month]}*\n\n${lines.join('\n')}`;
    }

    case 'consultar_ahorros': {
      if (data.savings.length === 0) return '🐷 No tenés metas de ahorro.';
      const lines = data.savings.map(sv => {
        const pct = Math.round((sv.current / sv.target) * 100);
        return `🐷 *${sv.name}*: ${fmt(sv.current)} / ${fmt(sv.target)} (${pct}%)`;
      });
      return `🐷 *Tus ahorros*\n\n${lines.join('\n')}`;
    }

    case 'consultar_deudas': {
      if (data.debts.length === 0) return '✅ No tenés deudas registradas.';
      const total = data.debts.reduce((s, d) => s + d.remaining, 0);
      const lines = data.debts.map(d =>
        `💳 *${d.name}*: ${fmt(d.remaining)} restante${d.installment > 0 ? ` · cuota ${fmt(d.installment)}` : ''}`
      );
      return `💳 *Tus deudas*\n\n${lines.join('\n')}\n\n📊 Total: ${fmt(total)}`;
    }

    case 'consultar_vencimientos': {
      const events = data.events || [];
      const todayDay = new Date().getDate();
      const upcoming = events
        .filter(ev => ev.day >= todayDay)
        .sort((a, b) => a.day - b.day)
        .slice(0, 10);
      if (upcoming.length === 0) return '✅ No hay vencimientos próximos este mes.';
      const lines = upcoming.map(ev => {
        const daysLeft = ev.day - todayDay;
        const urgency = daysLeft === 0 ? '🔴 HOY' : daysLeft <= 3 ? `🟡 en ${daysLeft} días` : `📅 día ${ev.day}`;
        return `${urgency} — ${ev.title}`;
      });
      return `⚠️ *Vencimientos del mes*\n\n${lines.join('\n')}`;
    }

    case 'agregar_evento': {
      const ev = {
        id: Date.now().toString(),
        title: action.title,
        day: parseInt(action.day),
        type: action.eventType || 'recordatorio',
        notifyDaysBefore: 2,
      };
      const newData = { ...data, events: [...(data.events || []), ev] };
      await saveData(process.env.USER_ID, newData);
      return `📅 *Evento agregado*\n\n📝 ${ev.title}\n📆 Día ${ev.day} de cada mes\n🔔 Tipo: ${ev.type}`;
    }

    case 'eliminar_evento': {
      const events = (data.events || []).filter(e =>
        !e.title.toLowerCase().includes(action.keyword.toLowerCase())
      );
      const newData = { ...data, events };
      await saveData(process.env.USER_ID, newData);
      return `🗑️ Evento eliminado correctamente.`;
    }

    case 'resumen_general': {
      const txs = data.transactions.filter(t => {
        const { month: m, year: y } = parseDateParts(t.date);
        return m === month && y === year;
      });
      const ingresos = txs.filter(t => t.type === 'ingreso' || t.type === 'sueldo').reduce((a, t) => a + t.amount, 0);
      const gastos = txs.filter(t => t.type === 'gasto').reduce((a, t) => a + t.amount, 0);
      const balance = ingresos - gastos;
      const totalDeudas = data.debts.reduce((s, d) => s + d.remaining, 0);
      const totalAhorros = data.savings.reduce((s, sv) => s + (sv.current || 0), 0);
      const todayDay = new Date().getDate();
      const proximosVenc = (data.events || []).filter(ev => ev.day >= todayDay && ev.day <= todayDay + 7);
      let resp = `🌟 *Resumen de ${MONTH_NAMES[month]}*\n\n`;
      resp += `💰 Ingresos: ${fmt(ingresos)}\n`;
      resp += `💸 Gastos: ${fmt(gastos)}\n`;
      resp += `${balance >= 0 ? '✅' : '⚠️'} Balance: ${fmt(balance)}\n`;
      resp += `💳 Deuda total: ${fmt(totalDeudas)}\n`;
      resp += `🐷 Ahorros: ${fmt(totalAhorros)}\n`;
      if (proximosVenc.length > 0) {
        resp += `\n⚠️ *Vencimientos esta semana:*\n`;
        proximosVenc.forEach(ev => { resp += `• ${ev.title} (día ${ev.day})\n`; });
      }
      return resp;
    }

    default:
      return '🤔 No entendí bien lo que querés hacer. Intentá con:\n• "gasté $X en Y"\n• "cobré sueldo $X"\n• "balance"\n• "deudas"\n• "ahorros"\n• "vencimientos"\n• "agregar vencimiento X el día N"';
  }
}

// ── Claude AI interpreter ──────────────────────────────────
async function interpretMessage(message, data) {
  const { month, year } = currentMonth();

  const systemPrompt = `Sos el asistente financiero de Orbe. Interpretás mensajes en lenguaje natural y devolvés SOLO un JSON con la acción a realizar.

Fecha actual: ${today()} (Argentina, UTC-3)
Mes actual: ${MONTH_NAMES[month]} ${year}

ACCIONES DISPONIBLES:

1. Registrar gasto:
{"type":"agregar_transaccion","txType":"gasto","description":"...","amount":1234,"category":"Alimentación","date":"YYYY-MM-DD"}

2. Registrar ingreso/sueldo:
{"type":"agregar_transaccion","txType":"sueldo","description":"Sueldo","amount":1234,"date":"YYYY-MM-DD"}
o {"type":"agregar_transaccion","txType":"ingreso","description":"...","amount":1234,"date":"YYYY-MM-DD"}

3. Consultar balance del mes:
{"type":"consultar_balance"}

4. Ver últimas transacciones:
{"type":"ultimas_transacciones"}

5. Ver presupuesto:
{"type":"consultar_presupuesto"}

6. Ver ahorros:
{"type":"consultar_ahorros"}

7. Ver deudas:
{"type":"consultar_deudas"}

8. Ver vencimientos/facturas:
{"type":"consultar_vencimientos"}

9. Agregar evento/vencimiento/recordatorio:
{"type":"agregar_evento","title":"...","day":15,"eventType":"vencimiento|pago|recordatorio"}

10. Eliminar evento:
{"type":"eliminar_evento","keyword":"..."}

11. Resumen general:
{"type":"resumen_general"}

CATEGORÍAS DISPONIBLES: ${JSON.stringify(Object.keys(data.categories || {}))}

REGLAS:
- Si dicen "gasté", "pagué", "compré" → agregar_transaccion con txType "gasto"
- Si dicen "cobré", "me pagaron", "sueldo", "ingresé" → txType "sueldo" o "ingreso"
- Si dicen "en X días/semanas" → calculá la fecha exacta sumando al día de hoy
- Si dicen "el día X" del mes → usá ese día con el mes actual
- Si mencionan kinesio, médico, luz, internet, etc → detectar categoría apropiada
- La fecha siempre en formato YYYY-MM-DD
- Devolvé SOLO el JSON, sin texto adicional`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    // Si Claude no devuelve JSON válido, intentamos extraerlo
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { type: 'unknown' };
  }
}

// ── Webhook principal ──────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From;

    if (!incomingMsg) {
      twiml.message('Mandame un mensaje y te ayudo con tus finanzas 💚');
      return res.type('text/xml').send(twiml.toString());
    }

    console.log(`📩 Mensaje de ${from}: ${incomingMsg}`);

    // Cargar datos del usuario
    const data = await loadData(process.env.USER_ID);
    if (!data) {
      twiml.message('❌ No pude cargar tus datos. Abrí la app Orbe primero.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Interpretar con Claude
    const action = await interpretMessage(incomingMsg, data);
    console.log('🤖 Acción:', JSON.stringify(action));

    // Ejecutar acción
    const respuesta = await processAction(action, data);

    twiml.message(respuesta);
  } catch (err) {
    console.error('❌ Error:', err);
    twiml.message('❌ Ocurrió un error. Intentá de nuevo en un momento.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Health check ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Orbe Bot', version: '1.0.0' });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Orbe Bot corriendo en puerto ${PORT}`);
});
