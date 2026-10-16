// AVISO NA HORA DO RETORNO -- regra pura, sem React e sem banco.
//
// O operador marca "Agendar retorno" com data e hora na tabulacao. A hora
// sempre existiu no formulario e estava preenchida em 0 de 13.293 registros
// (medido 15/10/2026): era um campo de 120px sem rotulo ao lado da data.
// Agora ela ganha nome e, principalmente, consequencia -- quando a hora chega,
// a tela abre um aviso no centro com o nome do aluno e o caminho para a ficha.
//
// REGRAS, todas deliberadas:
//  * so retorno de HOJE, agendado pelo OPERADOR e ainda nao tratado;
//  * so com hora preenchida -- sem hora nao existe "quando avisar" (a gestao
//    decidiu em 15/10/2026 manter a hora opcional: retorno sem hora continua
//    valendo, apenas nao toca);
//  * um aviso por vez, o mais atrasado primeiro: duas caixas empilhadas em
//    cima da ficha seriam pior que nenhuma;
//  * o que ja foi avisado nao volta sozinho. Quem decide o reaparecimento e o
//    operador, pelo "lembrar depois".

// "HH:MM" do relogio local de quem esta olhando. O retorno foi combinado no
// fuso do operador; comparar com UTC avisaria 3 horas antes.
export function horaAgoraLocal(agora = new Date()) {
  const h = String(agora.getHours()).padStart(2, "0");
  const m = String(agora.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function normalizarHora(hora) {
  const s = String(hora ?? "").trim();
  if (!/^\d{1,2}:\d{2}/.test(s)) return "";
  const [h, m] = s.split(":");
  return `${String(h).padStart(2, "0")}:${m.slice(0, 2)}`;
}

// Soma minutos a uma hora "HH:MM", sem passar do fim do dia -- 23:50 + 30 min
// fica 23:59 em vez de virar 00:20 e tocar de novo no comeco do dia seguinte.
export function somarMinutos(hora, minutos) {
  const base = normalizarHora(hora);
  if (!base) return "";
  const [h, m] = base.split(":").map(Number);
  const total = h * 60 + m + Number(minutos || 0);
  if (!Number.isFinite(total)) return base;
  const limite = 23 * 60 + 59;
  const fim = Math.max(0, Math.min(limite, total));
  return `${String(Math.floor(fim / 60)).padStart(2, "0")}:${String(fim % 60).padStart(2, "0")}`;
}

// A hora do retorno chegou? Compara texto "HH:MM" com texto "HH:MM" -- ambos
// no mesmo formato e no mesmo fuso, entao a comparacao lexicografica e a
// comparacao de relogio.
export function horaChegou(horaRetorno, horaAgora) {
  const alvo = normalizarHora(horaRetorno);
  const agora = normalizarHora(horaAgora);
  if (!alvo || !agora) return false;
  return agora >= alvo;
}

// O retorno que deve estar na tela agora, ou null.
//
// `retornos` sao os do bloco "Meu dia" (ja escopados ao operador e so os que
// ele agendou). `silenciados` mapeia aluno_id -> hora a partir da qual pode
// voltar a avisar: "" (ou qualquer hora ja passada) significa nunca mais hoje,
// e e assim que "ja liguei" difere de "lembrar depois".
export function retornoParaAvisar(retornos, { hoje, horaAgora, silenciados } = {}) {
  const dia = String(hoje || "").slice(0, 10);
  const agora = normalizarHora(horaAgora);
  if (!dia || !agora) return null;
  const mapa = silenciados instanceof Map ? silenciados : new Map(Object.entries(silenciados || {}));

  const candidatos = (Array.isArray(retornos) ? retornos : []).filter((r) => {
    if (!r || r.tratado) return false;
    if (String(r.data || "").slice(0, 10) !== dia) return false;
    const hora = normalizarHora(r.hora_retorno);
    if (!hora) return false; // sem hora nao ha quando avisar
    if (!horaChegou(hora, agora)) return false;
    if (!mapa.has(String(r.id))) return true;
    // Silenciado: so volta quando a hora do "lembrar depois" chegar. Sem hora
    // guardada, nao volta hoje.
    const volta = normalizarHora(mapa.get(String(r.id)));
    return volta ? horaChegou(volta, agora) : false;
  });

  if (candidatos.length === 0) return null;
  // O mais atrasado primeiro; empate pelo nome, para a ordem nao depender da
  // ordem em que o banco devolveu as linhas.
  return [...candidatos].sort(
    (a, b) =>
      normalizarHora(a.hora_retorno).localeCompare(normalizarHora(b.hora_retorno)) ||
      String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR")
  )[0];
}

// Quantos minutos de atraso o aviso ja tem -- vira "combinado para as 14:30
// (há 12 min)" na caixa.
export function minutosDeAtraso(horaRetorno, horaAgora) {
  const alvo = normalizarHora(horaRetorno);
  const agora = normalizarHora(horaAgora);
  if (!alvo || !agora) return 0;
  const min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return Math.max(0, min(agora) - min(alvo));
}

// Chave do dia para a memoria do navegador: o que foi silenciado hoje nao vale
// amanha, e amanha o retorno de amanha volta a tocar.
export function chaveSilenciados(hoje) {
  return `rv-retorno-silenciado-${String(hoje || "").slice(0, 10)}`;
}
