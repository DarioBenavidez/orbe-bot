require('dotenv').config();
const fetch = require('node-fetch');
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ── Helpers de fecha ───────────────────────────────────────
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

// ── Supabase: datos financieros ────────────────────────────
async function loadData(uid) {
  const { data, error } = await supabase.from('finanzas').select('data').eq('id', uid).single();
  if (error || !data) return null;
  return data.data;
}
async function saveData(uid, payload) {
  await supabase.from('finanzas').upsert({ id: uid, data: payload, updated_at: new Date().toISOString() });
}

// ── Supabase: usuarios de WhatsApp ─────────────────────────
async function getUserIdByPhone(phone) {
  const { data, error } = await supabase.from('whatsapp_users').select('user_id, user_name').eq('phone', phone).single();
  if (error || !data) return null;
  return data;
}
async function linkPhoneToUser(phone, userId) {
  await supabase.from('whatsapp_users').upsert({ phone, user_id: userId, linked_at: new Date().toISOString() });
}

// ── Supabase: historial de conversación ───────────────────
async function loadHistory(phone) {
  const { data, error } = await supabase.from('chat_history').select('messages').eq('phone', phone).single();
  if (error || !data) return [];
  return data.messages || [];
}
async function saveHistory(phone, messages) {
  // Guardamos solo los últimos 30 mensajes para no crecer indefinidamente
  const trimmed = messages.slice(-30);
  await supabase.from('chat_history').upsert({ phone, messages: trimmed, updated_at: new Date().toISOString() });
}

// ── Groq AI ────────────────────────────────────────────────
async function callGroq(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: 600,
      temperature: 0.3,
      messages,
    }),
  });
  const result = await response.json();
  return result.choices[0].message.content.trim();
}

// ── Interpretar acción con Groq ────────────────────────────
async function interpretMessage(userMessage, data, history) {
  const { month, year } = currentMonth();

  const systemPrompt = `Sos Orbe, un asistente financiero personal amigable, cercano e inteligente. Hablás en español argentino informal. Tu personalidad es cálida, empática y a veces con humor suave. Usás el nombre del usuario cuando lo sabés.

Fecha hoy: ${today()} | Mes actual: ${MONTH_NAMES[month]} ${year}

Tu tarea es interpretar el mensaje del usuario y devolver SOLO un JSON con la acción a realizar. Tenés acceso al historial de la conversación para entender el contexto.

ACCIONES DISPONIBLES:
{"type":"agregar_transaccion","txType":"gasto|ingreso|sueldo","description":"...","amount":1234,"category":"...","date":"YYYY-MM-DD"}
{"type":"consultar_balance"}
{"type":"ultimas_transacciones"}
{"type":"consultar_presupuesto"}
{"type":"consultar_presupuesto_categoria","category":"Ropa"}
{"type":"actualizar_presupuesto","category":"Ropa","limit":5000}
{"type":"consultar_ahorros"}
{"type":"consultar_deudas"}
{"type":"consultar_vencimientos"}
{"type":"agregar_evento","title":"...","day":15,"eventType":"vencimiento|pago|recordatorio","notify":true}
{"type":"eliminar_evento","keyword":"..."}
{"type":"resumen_general"}
{"type":"agregar_prestamo","name":"Claudio","amount":4000,"reason":"coca cola"}
{"type":"registrar_pago_prestamo","name":"Claudio","amount":100}
{"type":"consultar_prestamo","name":"Claudio"}
{"type":"consultar_todos_prestamos"}
{"type":"agregar_gasto_fijo","description":"Gimnasio","amount":8000,"category":"Salud","day":1}
{"type":"eliminar_gasto_fijo","keyword":"gimnasio"}
{"type":"conversacion","respuesta":"..."}
{"type":"unknown"}

CATEGORÍAS DISPONIBLES: ${JSON.stringify(Object.keys(data.categories||{}))}

REGLAS IMPORTANTES:
- "gasté/pagué/compré" → txType "gasto"
- "cobré/sueldo/me pagaron/ingresé" → txType "sueldo" o "ingreso"  
- "en X días/semanas" → calculá la fecha exacta desde hoy
- "agregar/modificar presupuesto en X" → actualizar_presupuesto
- "me debe / le presté / fiado" → agregar_prestamo
- "X me pagó / abonó / me dio" → registrar_pago_prestamo
- Si el usuario hace una pregunta general de finanzas o charla, usá "conversacion" con una respuesta amigable
- Si detectás contenido obsceno o inapropiado, usá "conversacion" con respuesta amigable redirigiendo a finanzas
- Si no entendés bien, usá "unknown"
- Devolvé SOLO el JSON, sin texto adicional ni explicaciones`;

  // Construimos el array de mensajes con historial
  const groqMessages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10), // últimos 10 mensajes de contexto
    { role: 'user', content: userMessage }
  ];

  const text = await callGroq(groqMessages);
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { type: 'unknown' };
  }
}

// ── Generar respuesta amigable con Groq ────────────────────
async function generateFriendlyResponse(context, userName) {
  const name = userName || 'amigo';
  const messages = [
    {
      role: 'system',
      content: `Sos Orbe, un asistente financiero personal amigable y cercano. Hablás en español argentino informal. Tu personalidad es cálida, empática y a veces con humor suave. El nombre del usuario es ${name}. Respondés de forma corta, natural y amigable. Usás emojis con moderación.`
    },
    { role: 'user', content: context }
  ];
  return await callGroq(messages);
}

// ── Procesar acciones ──────────────────────────────────────
async function processAction(action, data, userId, userName) {
  const { month, year } = currentMonth();
  const name = userName || '';

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
      
      // Respuesta variada y amigable
      const confirmaciones = [
        `${emoji} *${label} registrado${name ? ', ' + name : ''}!*\n\n📝 ${tx.description}\n💵 ${fmt(tx.amount)}\n📅 ${tx.date}`,
        `${emoji} *Listo${name ? ' ' + name : ''}!* Registré el ${label.toLowerCase()}.\n\n📝 ${tx.description}\n💵 ${fmt(tx.amount)}\n📅 ${tx.date}`,
        `${emoji} *Anotado!* ${label} de ${fmt(tx.amount)} por ${tx.description} guardado. ✅`,
      ];
      return confirmaciones[Math.floor(Math.random() * confirmaciones.length)];
    }

    case 'actualizar_presupuesto': {
      const budgets = data.budgets.map(b => 
        b.cat.toLowerCase() === action.category.toLowerCase() 
          ? { ...b, limit: parseFloat(action.limit) }
          : b
      );
      // Si no existe la categoría, la creamos
      const exists = data.budgets.some(b => b.cat.toLowerCase() === action.category.toLowerCase());
      if (!exists) budgets.push({ cat: action.category, limit: parseFloat(action.limit) });
      await saveData(userId, { ...data, budgets });
      return `🎯 *Presupuesto actualizado!*\n\n📦 ${action.category}: ${fmt(action.limit)} por mes\n\nCualquier gasto en esa categoría se va a descontar de este límite.`;
    }

    case 'consultar_presupuesto_categoria': {
      const txs = data.transactions.filter(t => {
        const {month:m,year:y} = parseDateParts(t.date);
        return m===month && y===year && t.type==='gasto' && t.category.toLowerCase()===action.category.toLowerCase();
      });
      const spent = txs.reduce((a,t)=>a+t.amount,0);
      const budget = data.budgets.find(b => b.cat.toLowerCase()===action.category.toLowerCase());
      if (!budget || !budget.limit) return `📭 No tenés presupuesto configurado para *${action.category}*.\n\n¿Querés que te agregue uno? Decime el monto.`;
      const pct = Math.round((spent/budget.limit)*100);
      const bar = pct>=100?'🔴':pct>=80?'🟡':'🟢';
      return `${bar} *Presupuesto ${action.category}*\n\n💸 Gastado: ${fmt(spent)}\n🎯 Límite: ${fmt(budget.limit)}\n📊 Uso: ${pct}%\n💰 Disponible: ${fmt(Math.max(0, budget.limit - spent))}`;
    }

    case 'consultar_balance': {
      const txs = data.transactions.filter(t => { const {month:m,year:y}=parseDateParts(t.date); return m===month&&y===year; });
      const ingresos = txs.filter(t=>t.type==='ingreso'||t.type==='sueldo').reduce((a,t)=>a+t.amount,0);
      const gastos = txs.filter(t=>t.type==='gasto').reduce((a,t)=>a+t.amount,0);
      const balance = ingresos - gastos;
      const estado = balance >= 0 ? '✅ Vas bien!' : '⚠️ Ojo con los gastos!';
      return `📊 *Balance de ${MONTH_NAMES[month]}${name ? ', ' + name : ''}*\n\n💰 Ingresos: ${fmt(ingresos)}\n💸 Gastos: ${fmt(gastos)}\n${balance>=0?'✅':'⚠️'} Balance: ${fmt(balance)}\n\n${estado}`;
    }

    case 'ultimas_transacciones': {
      const txs = data.transactions.filter(t => { const {month:m,year:y}=parseDateParts(t.date); return m===month&&y===year; }).slice(-5).reverse();
      if (!txs.length) return `📭 No hay transacciones este mes todavía${name ? ', ' + name : ''}. ¡Empezá registrando algo!`;
      return `🕐 *Últimas transacciones*\n\n${txs.map(t=>`${t.type==='gasto'?'💸':'💰'} ${t.description} — ${fmt(t.amount)} (${t.date})`).join('\n')}`;
    }

    case 'consultar_presupuesto': {
      const txs = data.transactions.filter(t => { const {month:m,year:y}=parseDateParts(t.date); return m===month&&y===year&&t.type==='gasto'; });
      const expByCat = txs.reduce((acc,t)=>{ acc[t.category]=(acc[t.category]||0)+t.amount; return acc; },{});
      const cats = data.categories||{};
      const lines = data.budgets.filter(b=>b.limit>0).map(b => {
        const spent = expByCat[b.cat]||0;
        const pct = Math.round((spent/b.limit)*100);
        return `${pct>=100?'🔴':pct>=80?'🟡':'🟢'} ${cats[b.cat]||'📦'} ${b.cat}: ${fmt(spent)} / ${fmt(b.limit)} (${pct}%)`;
      });
      if (!lines.length) return `📭 No tenés presupuestos configurados${name ? ', ' + name : ''}.\n\nPodés agregar uno diciéndome: *"agregá $5000 de presupuesto en Ropa"*`;
      return `🎯 *Presupuesto ${MONTH_NAMES[month]}*\n\n${lines.join('\n')}`;
    }

    case 'consultar_ahorros': {
      if (!data.savings.length) return `🐷 No tenés metas de ahorro todavía${name ? ', ' + name : ''}.\n\n¿Querés crear una? Decime para qué y cuánto.`;
      return `🐷 *Tus ahorros*\n\n${data.savings.map(sv=>`🐷 *${sv.name}*: ${fmt(sv.current)} / ${fmt(sv.target)} (${Math.round((sv.current/sv.target)*100)}%)`).join('\n')}`;
    }

    case 'consultar_deudas': {
      if (!data.debts.length) return `✅ No tenés deudas registradas${name ? ', ' + name : ''}. ¡Excelente!`;
      const total = data.debts.reduce((s,d)=>s+d.remaining,0);
      return `💳 *Tus deudas*\n\n${data.debts.map(d=>`💳 *${d.name}*: ${fmt(d.remaining)}${d.installment>0?` · cuota ${fmt(d.installment)}`:''}`).join('\n')}\n\n📊 Total: ${fmt(total)}`;
    }

    case 'consultar_vencimientos': {
      const todayDay = new Date().getDate();
      const upcoming = (data.events||[]).filter(ev=>ev.day>=todayDay).sort((a,b)=>a.day-b.day).slice(0,10);
      if (!upcoming.length) return `✅ No hay vencimientos próximos este mes${name ? ', ' + name : ''}. ¡Todo tranquilo!`;
      return `⚠️ *Vencimientos del mes*\n\n${upcoming.map(ev=>{ const d=ev.day-todayDay; return `${d===0?'🔴 HOY':d<=3?`🟡 en ${d} días`:`📅 día ${ev.day}`} — ${ev.title}`; }).join('\n')}`;
    }

    case 'agregar_evento': {
      const ev = { id:Date.now().toString(), title:action.title, day:parseInt(action.day), type:action.eventType||'recordatorio', notifyDaysBefore: action.notify ? 3 : 0 };
      await saveData(userId, { ...data, events:[...(data.events||[]), ev] });
      const notifMsg = action.notify ? '\n🔔 Te voy a avisar 3 días antes.' : '';
      return `📅 *Evento agregado!*\n\n📝 ${ev.title}\n📆 Día ${ev.day} de cada mes${notifMsg}`;
    }

    case 'eliminar_evento': {
      const before = (data.events||[]).length;
      const events = (data.events||[]).filter(e=>!e.title.toLowerCase().includes(action.keyword.toLowerCase()));
      await saveData(userId, { ...data, events });
      if (events.length === before) return `🤔 No encontré ningún evento con ese nombre. ¿Cómo se llamaba exactamente?`;
      return `🗑️ Listo, eliminé el evento correctamente.`;
    }

    case 'agregar_prestamo': {
      const loans = data.loans || [];
      const loan = {
        id: Date.now().toString(),
        name: action.name,
        reason: action.reason || '',
        amount: parseFloat(action.amount),
        remaining: parseFloat(action.amount),
        payments: [],
        createdAt: today(),
      };
      await saveData(userId, { ...data, loans: [...loans, loan] });
      return `📋 *Préstamo registrado!*\n\n👤 ${action.name} te debe ${fmt(action.amount)}${action.reason ? `\n📝 Por: ${action.reason}` : ''}\n📅 Fecha: ${today()}\n\nCuando te pague algo, avisame y lo registro.`;
    }

    case 'registrar_pago_prestamo': {
      const loans = data.loans || [];
      const idx = loans.findIndex(l => l.name.toLowerCase().includes(action.name.toLowerCase()));
      if (idx === -1) return `🤔 No encontré ningún préstamo a nombre de *${action.name}*. ¿Cómo se llama exactamente?`;
      const loan = { ...loans[idx] };
      const pagado = parseFloat(action.amount);
      loan.remaining = Math.max(0, loan.remaining - pagado);
      loan.payments = [...(loan.payments||[]), { date: today(), amount: pagado }];
      loans[idx] = loan;
      await saveData(userId, { ...data, loans });
      if (loan.remaining === 0) return `🎉 *${action.name} saldó la deuda!*\n\nPagó ${fmt(pagado)} y quedó en cero. ¡Cerramos ese préstamo!`;
      return `💵 *Pago registrado!*\n\n👤 ${action.name} pagó ${fmt(pagado)}\n💰 Le quedan: ${fmt(loan.remaining)}\n\n¡Poco a poco se va pagando!`;
    }

    case 'consultar_prestamo': {
      const loans = data.loans || [];
      const loan = loans.find(l => l.name.toLowerCase().includes(action.name.toLowerCase()));
      if (!loan) return `🤔 No encontré ningún préstamo a nombre de *${action.name}*.`;
      const pagosStr = loan.payments.length > 0
        ? `\n\n📜 *Historial de pagos:*\n${loan.payments.map(p=>`• ${p.date}: ${fmt(p.amount)}`).join('\n')}`
        : '\n\n📭 Todavía no hizo ningún pago.';
      return `📋 *Préstamo de ${loan.name}*\n\n💰 Monto original: ${fmt(loan.amount)}\n💸 Ya pagó: ${fmt(loan.amount - loan.remaining)}\n⏳ Le queda: ${fmt(loan.remaining)}${loan.reason ? `\n📝 Por: ${loan.reason}` : ''}${pagosStr}`;
    }

    case 'consultar_todos_prestamos': {
      const loans = data.loans || [];
      if (!loans.length) return `📭 No tenés préstamos registrados${name ? ', ' + name : ''}.`;
      const total = loans.reduce((s,l)=>s+l.remaining,0);
      const lista = loans.map(l=>`👤 *${l.name}*: ${fmt(l.remaining)}${l.reason?` (${l.reason})`:''}`).join('\n');
      return `📋 *Préstamos pendientes*\n\n${lista}\n\n💰 Total que te deben: ${fmt(total)}`;
    }

    case 'agregar_gasto_fijo': {
      const recurringExpenses = data.recurringExpenses || [];
      const gasto = {
        id: Date.now().toString(),
        description: action.description,
        amount: parseFloat(action.amount),
        category: action.category || 'Otros',
        day: parseInt(action.day) || 1,
        active: true,
      };
      await saveData(userId, { ...data, recurringExpenses: [...recurringExpenses, gasto] });
      return `🔄 *Gasto fijo agregado!*\n\n📝 ${gasto.description}: ${fmt(gasto.amount)}/mes\n📆 Se registra el día ${gasto.day} de cada mes automáticamente.`;
    }

    case 'eliminar_gasto_fijo': {
      const recurringExpenses = (data.recurringExpenses||[]).map(g=>
        g.description.toLowerCase().includes(action.keyword.toLowerCase())
          ? { ...g, active: false }
          : g
      );
      await saveData(userId, { ...data, recurringExpenses });
      return `✅ Listo, desactivé ese gasto fijo. Si algún mes lo querés volver a activar, avisame.`;
    }

    case 'resumen_general': {
      const txs = data.transactions.filter(t => { const {month:m,year:y}=parseDateParts(t.date); return m===month&&y===year; });
      const ingresos = txs.filter(t=>t.type==='ingreso'||t.type==='sueldo').reduce((a,t)=>a+t.amount,0);
      const gastos = txs.filter(t=>t.type==='gasto').reduce((a,t)=>a+t.amount,0);
      const balance = ingresos - gastos;
      const totalDeudas = data.debts.reduce((s,d)=>s+d.remaining,0);
      const totalAhorros = data.savings.reduce((s,sv)=>s+(sv.current||0),0);
      const totalPrestamos = (data.loans||[]).reduce((s,l)=>s+l.remaining,0);
      const todayDay = new Date().getDate();
      const proxVenc = (data.events||[]).filter(ev=>ev.day>=todayDay&&ev.day<=todayDay+7);
      let resp = `🌟 *Resumen de ${MONTH_NAMES[month]}${name ? ', ' + name : ''}*\n\n`;
      resp += `💰 Ingresos: ${fmt(ingresos)}\n`;
      resp += `💸 Gastos: ${fmt(gastos)}\n`;
      resp += `${balance>=0?'✅':'⚠️'} Balance: ${fmt(balance)}\n`;
      if (totalDeudas > 0) resp += `💳 Deudas: ${fmt(totalDeudas)}\n`;
      if (totalAhorros > 0) resp += `🐷 Ahorros: ${fmt(totalAhorros)}\n`;
      if (totalPrestamos > 0) resp += `📋 Te deben: ${fmt(totalPrestamos)}\n`;
      if (proxVenc.length) resp += `\n⚠️ *Vencimientos esta semana:*\n${proxVenc.map(ev=>`• ${ev.title} (día ${ev.day})`).join('\n')}`;
      return resp;
    }

    case 'conversacion': {
      return action.respuesta || `Contame, ¿en qué te puedo ayudar${name ? ', ' + name : ''}? 💚`;
    }

    default: {
      const frases = [
        `Perdoname${name ? ', ' + name : ''}, no te entendí bien 😅 ¿Qué registramos hoy?`,
        `Hmm, no me quedó claro 🤔 ¿Me lo contás de otra forma?`,
        `Perdón${name ? ', ' + name : ''}, ¿qué quisiste decir? Contame de nuevo 😊`,
      ];
      return frases[Math.floor(Math.random() * frases.length)];
    }
  }
}

// ── Notificaciones de vencimientos ────────────────────────
async function checkAndSendNotifications() {
  try {
    const { data: users } = await supabase.from('whatsapp_users').select('phone, user_id');
    if (!users) return;
    const todayDay = new Date().getDate();

    for (const user of users) {
      const data = await loadData(user.user_id);
      if (!data || !data.events) continue;

      for (const ev of data.events) {
        if (ev.notifyDaysBefore && ev.notifyDaysBefore > 0) {
          const daysUntil = ev.day - todayDay;
          if (daysUntil === ev.notifyDaysBefore || daysUntil === 1 || daysUntil === 0) {
            const msg = daysUntil === 0
              ? `🔴 *HOY* vence: *${ev.title}* ¡No te olvidés!`
              : `⚠️ En *${daysUntil} día${daysUntil>1?'s':''}* vence: *${ev.title}*`;
            await twilioClient.messages.create({
              from: 'whatsapp:+14155238886',
              to: user.phone,
              body: msg,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('Error en notificaciones:', err.message);
  }
}

// Revisar notificaciones cada hora
setInterval(checkAndSendNotifications, 60 * 60 * 1000);

// ── Webhook principal ──────────────────────────────────────
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

    // Activación desde la app (silenciosa)
    if (incomingMsg.startsWith('ORBE_ACTIVATE:')) {
      const userId = incomingMsg.replace('ORBE_ACTIVATE:', '').trim();
      if (userId) {
        await linkPhoneToUser(from, userId);
        twiml.message('✅ *¡Hola! Soy Orbe, tu asistente financiero personal* 🌟\n\nYa estamos conectados. Desde ahora podés consultarme todo sin abrir la app.\n\nProbá con:\n• *"balance"*\n• *"resumen"*\n• *"gasté $500 en café"*\n• *"¿cuánto tengo de presupuesto en ropa?"*');
        return res.type('text/xml').send(twiml.toString());
      }
    }

    // Buscar usuario
    const userInfo = await getUserIdByPhone(from);
    if (!userInfo) {
      twiml.message('👋 Para usar Orbe por WhatsApp, abrí la app y tocá *"Conectar WhatsApp"* 📱');
      return res.type('text/xml').send(twiml.toString());
    }

    const { user_id: userId, user_name: userName } = userInfo;

    // Cargar datos y historial
    const data = await loadData(userId);
    if (!data) {
      twiml.message('❌ No pude cargar tus datos. Abrí la app Orbe e intentá de nuevo.');
      return res.type('text/xml').send(twiml.toString());
    }

    const history = await loadHistory(from);

    // Interpretar mensaje
    const action = await interpretMessage(incomingMsg, data, history);
    console.log('🤖 Acción:', JSON.stringify(action));

    // Procesar acción
    const respuesta = await processAction(action, data, userId, userName);

    // Guardar historial
    const newHistory = [
      ...history,
      { role: 'user', content: incomingMsg },
      { role: 'assistant', content: respuesta },
    ];
    await saveHistory(from, newHistory);

    twiml.message(respuesta);

  } catch (err) {
    console.error('❌ Error:', err.message);
    twiml.message('❌ Ocurrió un error. Intentá de nuevo en un momento.');
  }
  res.type('text/xml').send(twiml.toString());
});

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Orbe Bot', version: '4.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Orbe Bot v4 en puerto ${PORT}`));
