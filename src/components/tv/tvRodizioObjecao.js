// =============================================================================
// TV ReATIVA — RODÍZIO DAS QUEBRAS DE OBJEÇÃO
// -----------------------------------------------------------------------------
// Módulo sem componente, de propósito: em arquivo .jsx que exporta um componente,
// qualquer export extra soma um erro de react-refresh na catraca de lint. Aqui
// mora só a conta, e tvObjecoes.jsx fica exportando apenas a tela.
//
// O PROBLEMA QUE ISTO RESOLVE
//
// O contador de voltas vive em `useState(0)` dentro de TvElogios: ele volta a
// ZERO a cada recarga da página. O telão é recarregado toda manhã — e sempre que
// alguém dá F5. Com `OBJECOES[giro % total]`, o dia inteiro começava na objeção
// 1, depois 2, depois 3. As últimas do catálogo nunca chegavam ao ar, e no dia
// seguinte tudo recomeçava exatamente igual.
//
// A CONTA
//
//   indice = ((dia + giro) * passo) % total
//
// `dia` é o número de dias desde a época, no calendário local — muda à
// meia-noite e é igual para qualquer hora do mesmo dia.
//
// `passo` é COPRIMO com o total. Essa é a peça que faz tudo funcionar, e vale
// explicar: quando mdc(passo, total) = 1, somar `passo` repetidamente percorre
// TODOS os índices antes de repetir qualquer um. Com 35 objeções e passo 22, a
// ordem é 0, 22, 9, 31, 18, 5, ... — as 35 passam em 35 voltas, sem repetir e
// sem nunca cair na vizinha da anterior. Se o passo dividisse o total (por
// exemplo 5 ou 7 em 35), o rodízio ficaria preso num punhado de objeções.
//
// As quatro propriedades pedidas saem todas dessa única linha:
//   - não repete em voltas consecutivas  -> passo % total nunca é 0
//   - distribui ao longo dos ciclos      -> o salto é grande, não vizinho
//   - não fica presa nas primeiras       -> percorre as `total` antes de repetir
//   - não reinicia igual no dia seguinte -> `dia` desloca o ponto de partida
// =============================================================================

// Maior divisor comum, pelo algoritmo de Euclides.
function mdc(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

// Passo coprimo com `total`, perto de 0,618 dele (razão áurea) para espalhar bem
// em vez de andar de um em um. Sobe até achar um coprimo; com total <= 2 o único
// passo possível é 1.
export function passoCoprimo(total) {
  const n = Math.trunc(Number(total) || 0);
  if (n <= 2) return 1;
  const alvo = Math.max(2, Math.round(n * 0.618));
  for (let p = alvo; p < n; p++) if (mdc(p, n) === 1) return p;   // sobe até n-1
  for (let p = alvo - 1; p >= 2; p--) if (mdc(p, n) === 1) return p; // depois desce
  return 1; // só chega aqui se nada acima servir; 1 é coprimo com tudo
}

// Número de dias decorridos até a data local de `hoje`. Usa Date.UTC sobre os
// componentes LOCAIS para não deslizar com fuso nem com horário de verão.
export function diaDoCalendario(hoje = new Date()) {
  const d = hoje instanceof Date && !Number.isNaN(hoje.getTime()) ? hoje : new Date();
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

// Índice da objeção para uma volta do carrossel num dia.
export function indiceDaObjecao(giro, total, hoje = new Date()) {
  const n = Math.trunc(Number(total) || 0);
  if (n <= 0) return 0;
  // Number.isFinite barra Infinity e NaN: sem isso, (dia + Infinity) % n = NaN e
  // a tela tentaria indexar OBJECOES[NaN]. Pego por teste de borda.
  const bruta = Number(giro);
  const g = Number.isFinite(bruta) ? Math.abs(Math.trunc(bruta)) : 0;
  const bruto = (diaDoCalendario(hoje) + g) * passoCoprimo(n);
  // `%` em JS devolve negativo para entrada negativa; a soma acima nunca é
  // negativa hoje, mas a normalização deixa a função segura para qualquer data.
  return ((bruto % n) + n) % n;
}
