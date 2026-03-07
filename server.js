require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function loadData(uid) {
  const { data, error } = await supabase.from('finanzas').select('data').eq('id', uid).single();
  if (error || !data) return null;
  return data.data;
}

async function saveData(uid, payload) {
  await supabase.from('finanzas').upsert({ id: uid, data: payload, updated_at: new Date().toISOString() });
}

async function getUserIdByPhone(phone) {
  const { data, error } = await supabase.from('whatsapp_users').select('user_id').eq('phone', phone).single();
  if (error || !data) return null;
  return data.user_id;
}

async function linkPhoneToUser(phone, userId) {
  await supabase.from('whatsapp_users').upsert({ phone, user_id: userId, linked_at: new Date().toISOString() });
}

function today() {
  const ar = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().split('T')[0];
}

function currentMonth() {
  const ar = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
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

async function interpretMessage(message, data) {
  const { month, year } = currentMonth();
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 300,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Sos el asistente financiero de Orbe. Interpretás mensajes y devolvés SOLO un JSON sin texto adicional.
Fecha: ${today()} | Mes: ${MONTH_NAMES[month]} ${year}

ACCIONES POSIBLES:
{"type":"agregar_transaccion","txType":"gasto|ingreso|sueldo","description":"...","amount":1234,"category":"...","date":"YYYY-MM-DD"}
{"type":"consultar_balance"}
{"type":"ultimas_transacciones"}
{"type":"consultar_presupuesto"}
{"type":"consultar_ahorros"}
{"type":"consultar_deudas"}
{"type":"consultar_vencimientos"}
{"type":"agregar_evento","title":"...","day":15,"eventType":"vencimiento|pago|recordatorio"}
{"type":"eliminar_evento","keyword":"..."}
{"type":"resumen_general"}

CATEGORÍAS: ${JSON.stringify(Object.keys(data.categories||{}))}
REGLAS:
- "gasté/pagué/compré" → txType "gasto"
- "cobré/sueldo/me pagaron" → txType "sueldo"
- "en X días/semanas" → calculá fecha exacta desde hoy
- Devolvé SOLO el JSON, nada más`
        },
        { role: 'user', content: message }
      ],
    }),
  });
  const result = await response.json();
  const text = result.choices[0].message.content.trim();
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { type: 'unknown' };
  }
}

async function processAction(action, data, userId) {
  const { month, year } = currentMonth();

  switch (action.type) {
    case 'agregar_transaccion': {
      const tx = {
        id: Date.now().toString(),
        type: action.txType || 'gasto',
        description: action.description,
        amount: parseFloat(action.amount),
        category: action.category || 'Otros',
        date: action.date || today(),
        savingsId: '',
      };
      await saveData(userId, { ...data, transactions: [...data.transactions, tx] });
      const label = tx.type === 'gasto' ? 'Gasto' : tx.type === 'sueldo' ? 'Sueldo' : 'Ingreso';
      const emoji = tx.type === 'gasto' ? '💸' : '💰';
      return `${emoji} *${label} registrado*\n\n📝 ${tx.description}\n💵 ${fmt(tx.amount)}\n📅 ${tx.date}`;
    }

    case 'consultar_balance': {
      const txs = data.transactions.filter(t => { const {month:m,year:y} = parseDateParts(t.date); return m===month&&y===year; });
      const ingresos = txs.filter(t=>t.type==='ingreso'||t.type==='sueldo').reduce((a,t)=>a+t.amount,0);
      const gastos = txs.filter(t=>t.type==='gasto').reduce((a,t)=>a+t.amount,0);
      const balance = ingresos - gastos;
      return `📊 *Balance de ${MONTH_NAMES[month]} ${year}*\n\n💰 Ingresos: ${fmt(ingresos)}\n💸 Gastos: ${fmt(gastos)}\n${balance>=0?'✅':'⚠️'} Balance: ${fmt(balance)}`;
    }

    case 'ultimas_transacciones': {
      const txs = data.transactions.filter(t => { const {month:m,year:y} = parseDateParts(t.date); return m===month&&y===year; }).slice(-5).reverse();
      if (!txs.length) return '📭 No hay transacciones este mes.';
      return `🕐 *Últimas transacciones*\n\n${txs.map(t=>`${t.type==='gasto'?'💸':'💰'} ${t.description} — ${fmt(t.amount)} (${t.date})`).join('\n')}`;
    }

    case 'consultar_presupuesto': {
      const txs = data.transactions.filter(t => { const {month:m,year:y} = parseDateParts(t.date); return m===month&&y===year&&t.type==='gasto'; });
      const expByCat = txs.reduce((acc,t)=>{ acc[t.category]=(acc[t.category]||0)+t.amount; return acc; },{});
      const cats = data.categories || {};
      const lines = data.budgets.filter(b=>b.limit>0).map(b => {
        const spent = expByCat[b.cat]||0;
        const pct = Math.round((spent/b.limit)*100);
        return `${pct>=100?'🔴':pct>=80?'🟡':'🟢'} ${cats[b.cat]||'📦'} ${b.cat}: ${fmt(spent)} / ${fmt(b.limit)} (${pct}%)`;
      });
      if (!lines.length) return '📭 No tenés presupuestos configurados.';
      return `🎯 *Presupuesto ${MONTH_NAMES[month]}*\n\n${lines.join('\n')}`;
    }

    case 'consultar_ahorros': {
      if (!data.savings.length) return '🐷 No tenés metas de ahorro.';
      return `🐷 *Tus ahorros*\n\n${data.savings.map(sv=>`🐷 *${sv.name}*: ${fmt(sv.current)} / ${fmt(sv.target)} (${Math.round((sv.current/sv.target)*100)}%)`).join('\n')}`;
    }

    case 'consultar_deudas': {
      if (!data.debts.length) return '✅ No tenés deudas registradas.';
      const total = data.debts.reduce((s,d)=>s+d.remaining,0);
      return `💳 *Tus deudas*\n\n${data.debts.map(d=>`💳 *${d.name}*: ${fmt(d.remaining)} restante${d.installment>0?` · cuota ${fmt(d.installment)}`:''}`).join('\n')}\n\n📊 Total: ${fmt(total)}`;
    }

    case 'consultar_vencimientos': {
      const todayDay = new Date().getDate();
      const upcoming = (data.events||[]).filter(ev=>ev.day>=todayDay).sort((a,b)=>a.day-b.day).slice(0,10);
      if (!upcoming.length) return '✅ No hay vencimientos próximos este mes.';
      return `⚠️ *Vencimientos del mes*\n\n${upcoming.map(ev=>{
        const d = ev.day-todayDay;
        return `${d===0?'🔴 HOY':d<=3?`🟡 en ${d} días`:`📅 día ${ev.day}`} — ${ev.title}`;
      }).join('\n')}`;
    }

    case 'agregar_evento': {
      const ev = { id:Date.now().toString(), title:action.title, day:parseInt(action.day), type:action.eventType||'recordatorio', notifyDaysBefore:2 };
      await saveData(userId, { ...data, events:[...(data.events||[]), ev] });
      return `📅 *Evento agregado*\n\n📝 ${ev.title}\n📆 Día ${ev.day} de cada mes`;
    }

    case 'eliminar_evento': {
      const events = (data.events||[]).filter(e=>!e.title.toLowerCase().includes(action.keyword.toLowerCase()));
      await saveData(userId, { ...data, events });
      return `🗑️ Evento eliminado correctamente.`;
    }

    case 'resumen_general': {
      const txs = data.transactions.filter(t => { const {month:m,year:y} = parseDateParts(t.date); return m===month&&y===year; });
      const ingresos = txs.filter(t=>t.type==='ingreso'||t.type==='sueldo').reduce((a,t)=>a+t.amount,0);
      const gastos = txs.filter(t=>t.type==='gasto').reduce((a,t)=>a+t.amount,0);
      const balance = ingresos - gastos;
      const totalDeudas = data.debts.reduce((s,d)=>s+d.remaining,0);
      const totalAhorros = data.savings.reduce((s,sv)=>s+(sv.current||0),0);
      const todayDay = new Date().getDate();
      const proxVenc = (data.events||[]).filter(ev=>ev.day>=todayDay&&ev.day<=todayDay+7);
      let resp = `🌟 *Resumen de ${MONTH_NAMES[month]}*\n\n💰 Ingresos: ${fmt(ingresos)}\n💸 Gastos: ${fmt(gastos)}\n${balance>=0?'✅':'⚠️'} Balance: ${fmt(balance)}\n💳 Deuda total: ${fmt(totalDeudas)}\n🐷 Ahorros: ${fmt(totalAhorros)}`;
      if (proxVenc.length) resp += `\n\n⚠️ *Vencimientos esta semana:*\n${proxVenc.map(ev=>`• ${ev.title} (día ${ev.day})`).join('\n')}`;
      return resp;
    }

    default:
      return '🤔 No entendí. Podés preguntarme:\n\n💸 *"gasté $X en Y"*\n💰 *"cobré sueldo $X"*\n📊 *"balance"*\n🕐 *"últimas transacciones"*\n🎯 *"presupuesto"*\n🐷 *"ahorros"*\n💳 *"deudas"*\n⚠️ *"vencimientos"*\n📅 *"agregar vencimiento X el día N"*\n🌟 *"resumen"*';
  }
}

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From;

    if (!incomingMsg) {
      twiml.message('Mandame un mensaje 💚');
      return res.type('text/xml').send(twiml.toString());
    }

    console.log(`📩 ${from}: ${incomingMsg}`);

    if (incomingMsg.startsWith('ORBE_ACTIVATE:')) {
      const userId = incomingMsg.replace('ORBE_ACTIVATE:', '').trim();
      if (userId) {
        await linkPhoneToUser(from, userId);
        twiml.message('✅ *¡Orbe activado!*\n\nYa estás conectado 🎉 Ahora podés consultarme todo desde acá sin abrir la app.\n\nProbá con:\n• *"balance"*\n• *"resumen"*\n• *"gasté $500 en café"*');
        return res.type('text/xml').send(twiml.toString());
      }
    }

    const userId = await getUserIdByPhone(from);
    if (!userId) {
      twiml.message('👋 Para usar Orbe por WhatsApp, abrí la app y tocá *"Conectar WhatsApp"* 📱');
      return res.type('text/xml').send(twiml.toString());
    }

    const data = await loadData(userId);
    if (!data) {
      twiml.message('❌ No pude cargar tus datos. Abrí la app Orbe e intentá de nuevo.');
      return res.type('text/xml').send(twiml.toString());
    }

    const action = await interpretMessage(incomingMsg, data);
    console.log('🤖 Acción:', JSON.stringify(action));
    const respuesta = await processAction(action, data, userId);
    twiml.message(respuesta);

  } catch (err) {
    console.error('❌ Error:', err.message);
    twiml.message('❌ Ocurrió un error. Intentá de nuevo.');
  }
  res.type('text/xml').send(twiml.toString());
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Orbe Bot', version: '3.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Orbe Bot v3 (Groq) en puerto ${PORT}`));
