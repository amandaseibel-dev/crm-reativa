// PRODUTIVIDADE OPERACIONAL -- agregacao pura, sem React e sem banco.
//
// Tudo aqui recebe linhas que a tela leu e devolve numero. Nenhuma funcao
// consulta o Supabase, para que cada regra possa ser testada com fixture.
//
// O QUE ESTE MODULO NAO FAZ, DE PROPOSITO
//
// 1) NAO define o que e acionamento. A lista canonica e
//    `TIPOS_ACIONAMENTO_INDIVIDUAL` em `carteiraAcionada.js` -- decisao da
//    gestao de 29/09/2026, com as contagens de producao no comentario dela. Ja
//    existem TRES listas divergentes no sistema (aquela com 7 tipos,
//    `PainelCarteira.jsx` com 2 e `MeuDashboard.jsx` com 11) mais a contagem
//    propria do banco dentro de `calibragem_efetividade`. Uma quarta lista aqui
//    seria metrica inventada: a tela importa a canonica e passa as linhas ja
//    filtradas por ela.
//
// 2) NAO mede "retorno cumprido". `alunos.retorno_confirmado_em` estava
//    preenchido em 0 linhas em producao em 22/10/2026 -- o campo existe e a
//    ficha sabe escrever nele, mas ninguem usa. Quem vai passar a alimenta-lo e
//    a frente do Meu Dia. Enquanto estiver zerado, "cumprido" nao entra nem
//    como aproximacao: so retorno AGENDADO e retorno VENCIDO, que sao fato na
//    coluna `data_retorno`.
//
// 3) NAO reconstroi saldo de carteira no passado. Nao existe snapshot diario
//    por operador (`historico_operacional` tem 34.330 linhas com os campos
//    100% nulos e parou em 30/06/2026; `historico_casos` e
//    `historico_atendimentos` estao vazias). A evolucao e, portanto, serie de
//    EVENTOS: acionamentos por dia e entradas na carteira por dia, cada uma
//    vinda de uma coluna que carrega a propria data.

// Pausas registradas em `ponto_operadores`. Veio da tela de ponto absorvida
// aqui (`PainelOperadores.jsx`, que estava no repo sem rota que a renderizasse).
export const PAUSAS = [
  { chave: "PAUSA_INTERVALO_1", label: "Pausa 1" },
  { chave: "PAUSA_INTERVALO_2", label: "Pausa 2" },
  { chave: "PAUSA_ALMOCO", label: "Almoço" },
];

// Rotulo do operador: e-mail minusculo e a chave; o nome e so para mostrar.
export function chaveOperador(email) {
  return String(email || "").toLowerCase().trim();
}

/**
 * Dia de calendario de um valor, no fuso de quem esta olhando.
 *
 * POR QUE NAO `toISOString().slice(0,10)`: o turno acaba as 18h de Brasilia e
 * a conta em UTC joga o fim da tarde para o dia seguinte quando o horario
 * passa das 21h. O dia que a gestao cobra e o dia do operador.
 *
 * E por que a excecao da string: coluna de DATA (`data_retorno`,
 * `semestre_divida`) ja chega como dia de calendario. Passar "2026-10-21" por
 * `new Date` da meia-noite UTC e, em BRT, devolveria 2026-10-20 -- um dia a
 * menos em toda a coluna.
 */
export function chaveDia(valor) {
  if (!valor) return null;

  if (typeof valor === "string") {
    const soData = valor.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (soData) return soData[1];
  }

  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;

  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${data.getFullYear()}-${mes}-${dia}`;
}

// Dia de calendario -> Date na meia-noite LOCAL (par de `chaveDia`).
export function diaParaData(chave) {
  const partes = String(chave || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!partes) return null;
  return new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
}

/**
 * Os `quantos` ultimos dias de calendario, terminando em `ate` (inclusive).
 * Devolve em ordem crescente.
 */
export function ultimosDias(quantos, ate = new Date()) {
  const total = Math.max(1, Number(quantos) || 1);
  const fim = diaParaData(chaveDia(ate));
  const dias = [];

  for (let i = total - 1; i >= 0; i -= 1) {
    const d = new Date(fim);
    d.setDate(d.getDate() - i);
    dias.push(chaveDia(d));
  }

  return dias;
}

// Primeiro instante do primeiro dia da janela -- e o corte que vai no `.gte()`.
export function corteDoPeriodo(quantos, ate = new Date()) {
  const dias = ultimosDias(quantos, ate);
  return diaParaData(dias[0]);
}

/**
 * SERIE DIARIA DE ACIONAMENTOS, por operador e por dia.
 *
 * `movs` precisa vir JA filtrado pelos tipos canonicos (a tela faz isso no
 * `.in("tipo", TIPOS_ACIONAMENTO_INDIVIDUAL)`), com
 * `registrado_por_email`, `registrado_por_nome` e `registrado_em`.
 *
 * A Efetividade (`calibragem_efetividade`) ja mostra o TOTAL de acionamentos
 * por operador no periodo. O que nao existe em tela nenhuma e a quebra por
 * dia -- ver quem caiu na quarta, nao so o total do mes. E isto que esta aqui.
 */
export function serieAcionamentos(movs, dias) {
  const noPeriodo = new Set(dias);
  const porOperador = new Map();
  const totalPorDia = Object.fromEntries(dias.map((d) => [d, 0]));
  let total = 0;

  for (const m of movs || []) {
    const dia = chaveDia(m?.registrado_em);
    if (!dia || !noPeriodo.has(dia)) continue;

    const email = chaveOperador(m?.registrado_por_email);
    if (!email) continue;

    if (!porOperador.has(email)) {
      porOperador.set(email, {
        email,
        nome: String(m?.registrado_por_nome || "").trim() || email,
        total: 0,
        porDia: Object.fromEntries(dias.map((d) => [d, 0])),
      });
    }

    const linha = porOperador.get(email);
    if (linha.nome === email) {
      const nome = String(m?.registrado_por_nome || "").trim();
      if (nome) linha.nome = nome;
    }

    linha.porDia[dia] += 1;
    linha.total += 1;
    totalPorDia[dia] += 1;
    total += 1;
  }

  const operadores = [...porOperador.values()].sort(
    (a, b) => b.total - a.total || a.nome.localeCompare(b.nome),
  );

  return { dias, operadores, totalPorDia, total };
}

// Minutos entre dois instantes; null quando falta uma ponta.
export function duracaoMinutos(inicio, fim) {
  if (!inicio || !fim) return null;
  const de = new Date(inicio).getTime();
  const ate = new Date(fim).getTime();
  if (Number.isNaN(de) || Number.isNaN(ate)) return null;
  return Math.round((ate - de) / 60000);
}

/**
 * PONTO POR OPERADOR E POR DIA, a partir dos eventos de `ponto_operadores`
 * (`email`, `nome`, `tipo`, `criado_em`). Absorvido da tela de ponto.
 *
 * Login = primeira batida do dia; logout = a ultima. Pausa em curso (inicio
 * sem fim) fica com duracao nula de proposito: nao se inventa fim.
 */
export function agruparPonto(eventos) {
  const grupos = new Map();

  for (const evento of eventos || []) {
    const dia = chaveDia(evento?.criado_em);
    const email = chaveOperador(evento?.email);
    if (!dia || !email) continue;

    const chave = `${email}|${dia}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        email,
        nome: String(evento?.nome || "").trim() || email,
        dia,
        eventos: [],
      });
    }
    grupos.get(chave).eventos.push(evento);
  }

  const linhas = [];

  for (const grupo of grupos.values()) {
    const ordenados = [...grupo.eventos].sort(
      (a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime(),
    );
    const quando = (tipo, ultima = false) => {
      const lista = ordenados.filter((e) => e.tipo === tipo);
      if (!lista.length) return null;
      return ultima ? lista[lista.length - 1].criado_em : lista[0].criado_em;
    };

    const pausas = PAUSAS.map(({ chave, label }) => {
      const inicio = quando(`${chave}_INICIO`);
      const fim = quando(`${chave}_FIM`, true);
      return { label, inicio, fim, duracao: duracaoMinutos(inicio, fim) };
    });

    const login = quando("LOGIN");
    const logout = quando("LOGOUT", true);
    const jornada = duracaoMinutos(login, logout);
    const emPausa = pausas.reduce((soma, p) => soma + (p.duracao || 0), 0);

    linhas.push({
      email: grupo.email,
      nome: grupo.nome,
      dia: grupo.dia,
      login,
      logout,
      pausas,
      minutosPausa: emPausa,
      // Jornada liquida = do login ao logout, menos as pausas fechadas. Null
      // quando falta login ou logout: dia sem as duas pontas nao vira hora.
      minutosTrabalhados: jornada == null ? null : Math.max(0, jornada - emPausa),
    });
  }

  return linhas.sort((a, b) => (a.dia === b.dia ? a.nome.localeCompare(b.nome) : a.dia < b.dia ? 1 : -1));
}

/**
 * PRESENCA x PRODUCAO -- o unico cruzamento que nao existe em tela nenhuma.
 *
 * Cada linha e um par operador+dia. Os dois lados ja existiam separados: o
 * ponto na tela absorvida, os acionamentos na Efetividade. O que se ve aqui e
 * um ao lado do outro, mais acionamentos por hora de jornada liquida.
 *
 * Dia com acionamento e SEM ponto aparece com `semPonto: true` em vez de ser
 * descartado: trabalho sem batida registrada e justamente o que a gestao quer
 * ver. Dia com ponto e sem acionamento tambem fica, com zero.
 */
export function cruzarPresencaProducao(linhasPonto, serie) {
  const porChave = new Map();

  for (const linha of linhasPonto || []) {
    porChave.set(`${linha.email}|${linha.dia}`, { ...linha, acionamentos: 0, semPonto: false });
  }

  for (const op of serie?.operadores || []) {
    for (const dia of serie.dias) {
      const qtd = op.porDia[dia] || 0;
      if (!qtd) continue;

      const chave = `${op.email}|${dia}`;
      if (porChave.has(chave)) {
        porChave.get(chave).acionamentos = qtd;
      } else {
        porChave.set(chave, {
          email: op.email,
          nome: op.nome,
          dia,
          login: null,
          logout: null,
          pausas: PAUSAS.map(({ label }) => ({ label, inicio: null, fim: null, duracao: null })),
          minutosPausa: 0,
          minutosTrabalhados: null,
          acionamentos: qtd,
          semPonto: true,
        });
      }
    }
  }

  const linhas = [...porChave.values()].map((l) => ({
    ...l,
    // So divide quando ha jornada medida. Sem logout, "por hora" seria chute.
    porHora:
      l.minutosTrabalhados && l.minutosTrabalhados > 0
        ? Number(((l.acionamentos * 60) / l.minutosTrabalhados).toFixed(1))
        : null,
  }));

  return linhas.sort((a, b) => (a.dia === b.dia ? a.nome.localeCompare(b.nome) : a.dia < b.dia ? 1 : -1));
}

// Texto unico de status, do mesmo jeito que `painel_geral` monta o dele.
function statusConcatenado(aluno) {
  return [aluno?.status_atual, aluno?.status_jornada, aluno?.status_acionamento]
    .map((p) => String(p || ""))
    .join(" ")
    .toUpperCase();
}

/**
 * PENDENCIAS POR OPERADOR.
 *
 * As regras NAO sao novas: sao as mesmas de `public.painel_geral`, que a tela
 * do Painel Geral ja mostra somadas para a operacao inteira. Aqui elas apenas
 * mudam de grao -- do total para o operador. Copiadas de la, uma a uma:
 *
 *   sem contato +10 dias  data_ultimo_acionamento <= now() - interval '10 days'
 *   em negociacao 24h     status concatenado contem 'ALUNO_EM_NEGOCIACAO_24H'
 *   retornos de hoje      data_retorno = current_date
 *
 * E uma que o Painel Geral nao tem, pela mesma coluna: retorno VENCIDO
 * (`data_retorno` < hoje e ainda na lista). Nao e indicador novo, e o outro
 * lado da comparacao que ja esta ali.
 *
 * `sem_responsavel` nao entra: por definicao nao tem operador a quem atribuir,
 * e continua sendo numero global do Painel Geral.
 */
export function pendenciasPorOperador(alunos, agora = new Date()) {
  const hoje = chaveDia(agora);
  const corteContato = new Date(agora);
  corteContato.setDate(corteContato.getDate() - 10);

  const porOperador = new Map();

  for (const aluno of alunos || []) {
    const email = chaveOperador(aluno?.responsavel_atual_email);
    if (!email) continue;

    if (!porOperador.has(email)) {
      porOperador.set(email, {
        email,
        nome: String(aluno?.responsavel_atual_nome || "").trim() || email,
        carteira: 0,
        semContato10: 0,
        negociacao24h: 0,
        retornosHoje: 0,
        retornosVencidos: 0,
      });
    }

    const linha = porOperador.get(email);
    if (linha.nome === email) {
      const nome = String(aluno?.responsavel_atual_nome || "").trim();
      if (nome) linha.nome = nome;
    }

    linha.carteira += 1;

    const ultimo = aluno?.data_ultimo_acionamento;
    if (ultimo) {
      const quando = new Date(ultimo);
      if (!Number.isNaN(quando.getTime()) && quando <= corteContato) linha.semContato10 += 1;
    }

    if (statusConcatenado(aluno).includes("ALUNO_EM_NEGOCIACAO_24H")) linha.negociacao24h += 1;

    const retorno = chaveDia(aluno?.data_retorno);
    if (retorno) {
      // Comparacao de texto 'YYYY-MM-DD' ordena como data e nao passa por fuso.
      if (retorno === hoje) linha.retornosHoje += 1;
      else if (retorno < hoje) linha.retornosVencidos += 1;
    }
  }

  const operadores = [...porOperador.values()].sort(
    (a, b) => b.carteira - a.carteira || a.nome.localeCompare(b.nome),
  );

  const totais = operadores.reduce(
    (soma, o) => ({
      carteira: soma.carteira + o.carteira,
      semContato10: soma.semContato10 + o.semContato10,
      negociacao24h: soma.negociacao24h + o.negociacao24h,
      retornosHoje: soma.retornosHoje + o.retornosHoje,
      retornosVencidos: soma.retornosVencidos + o.retornosVencidos,
    }),
    { carteira: 0, semContato10: 0, negociacao24h: 0, retornosHoje: 0, retornosVencidos: 0 },
  );

  return { operadores, totais };
}

/**
 * ENTRADAS NA CARTEIRA POR DIA.
 *
 * Fonte: `alunos.responsavel_atual_em` -- quando o aluno passou para o
 * responsavel ATUAL (preenchido em 7.621 de 7.623 alunos com dono, medido em
 * 22/10/2026).
 *
 * O QUE ISTO E E O QUE NAO E. E a data de entrada dos alunos que o operador
 * tem HOJE. Nao e historico de carteira: o aluno que ele teve e perdeu nao
 * aparece, porque a coluna guarda um valor so, o atual. Por isso a tela chama
 * de "entradas na carteira" e nao de "evolucao do saldo" -- essa segunda
 * exigiria snapshot diario, que nao existe.
 */
export function entradasPorDia(alunos, dias) {
  const noPeriodo = new Set(dias);
  const porOperador = new Map();
  const totalPorDia = Object.fromEntries(dias.map((d) => [d, 0]));
  let total = 0;

  for (const aluno of alunos || []) {
    const dia = chaveDia(aluno?.responsavel_atual_em);
    if (!dia || !noPeriodo.has(dia)) continue;

    const email = chaveOperador(aluno?.responsavel_atual_email);
    if (!email) continue;

    if (!porOperador.has(email)) {
      porOperador.set(email, {
        email,
        nome: String(aluno?.responsavel_atual_nome || "").trim() || email,
        total: 0,
        porDia: Object.fromEntries(dias.map((d) => [d, 0])),
      });
    }

    const linha = porOperador.get(email);
    linha.porDia[dia] += 1;
    linha.total += 1;
    totalPorDia[dia] += 1;
    total += 1;
  }

  const operadores = [...porOperador.values()].sort(
    (a, b) => b.total - a.total || a.nome.localeCompare(b.nome),
  );

  return { dias, operadores, totalPorDia, total };
}
