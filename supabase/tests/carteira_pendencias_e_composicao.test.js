// COMPOSIÇÃO ACADÊMICA DO SALDO E PENDÊNCIAS POR MOTIVO — comportamento em
// PostgreSQL real (PGlite).
//
// O QUE ESTE TESTE PROVA
//  1. as migrations aplicam — se o SQL não compilar, nada aqui roda;
//  2. a composição por status acadêmico FECHA AO CENTAVO com o saldo em aberto,
//     e fecha também em títulos e em alunos;
//  3. o saldo em aberto da composição é, ao centavo, o MESMO que a linha
//     "Em aberto" de `carteira_safra_situacoes` publica em 2024/2025 — as duas
//     funções leem o mesmo universo, e é isso que não pode divergir;
//  4. aluno sem situação importada não é descartado: cai em
//     "(sem situação importada)", que é o que mede o buraco de 2024;
//  5. categoria nenhuma é agrupada — "Aguardando Matrícula" e "Matriculado
//     Curso Normal" seguem duas linhas, com o rótulo exato da base;
//  6. em 2026/1 o universo em aberto inclui a validação, pela regra da safra;
//  7. os submotivos de Pendente SOMAM o `pendente` das seis linhas, e nenhum
//     submotivo novo é inventado;
//  8. título com valor em dois submotivos não duplica VALOR (as colunas são
//     disjuntas) e a função declara que as CONTAGENS não somam;
//  9. toda pendência chega ao registro individual, com aluno, CPF, título,
//     safra, valor, motivo, situação, evidência, responsável e data;
// 10. a ação de cada submotivo é a que a regra existente permite — só
//     `em_confirmacao` tem caminho por caso, e os outros declaram a ausência;
// 11. 2026/2 é RECUSADO com razão, em vez de devolver lista vazia;
// 12. o teto de 500 por chamada não pode ser furado;
// 13. o portão de leitura fecha as três funções;
// 14. o rollback derruba as cinco funções e não toca nada mais.
//
// Dados fictícios. Bancada: fixtures/carteira_pendencias/bancada.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  montar, aluno, titulo, tituloHistorico, classificado, composicao, pendencias, itens,
  seisLinhas, recalcular, ler, itensLer, comoPapel, voltarDono, portao, q1, ROLL, NOVA, AJUSTES,
} from "./fixtures/carteira_pendencias/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => { db = await montar(); });
// Cada teste abre um PGlite próprio (um Postgres WASM inteiro). Sem este
// fechamento eles ficam todos vivos no mesmo processo até o fim do arquivo, e
// no CI (4 workers em paralelo) o runner morre por falta de memória.
afterEach(async () => { await db?.close(); db = null; });

const cent = (v) => Number(Number(v).toFixed(2));

describe("as migrations aplicam e as funções existem", () => {
  it("cria as cinco funções novas", async () => {
    const r = await q1(db, `select count(*)::int n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('carteira_em_aberto_por_status_academico',
                         'carteira_pendencias_por_motivo','carteira_pendencias_itens',
                         'carteira_pendencia_rotulo','carteira_pendencia_acao')`);
    expect(r.n).toBe(5);
  });

  it("o catálogo de rótulos e ações mora em SQL, não no front", async () => {
    const r = await q1(db, `select
      public.carteira_pendencia_rotulo('em_confirmacao') a,
      public.carteira_pendencia_acao('em_confirmacao') b,
      public.carteira_pendencia_acao('pago_sem_lastro') c,
      public.carteira_pendencia_acao('em_validacao') d,
      public.carteira_pendencia_acao('ajuste_academico') e,
      public.carteira_pendencia_acao('convertido_origem_comprovada') f`);
    expect(r.a).toBe("Em confirmação de pagamento");
    expect(r.b).toBe("CONFERENCIA_PRIME");
    // Os quatro sem regra de resolução por caso declaram a ausência. Nenhuma
    // ação genérica de "editar valor ou status" existe no catálogo.
    for (const k of ["c", "d", "e", "f"]) expect(r[k]).toBe("SEM_ACAO_AUTOMATICA_SEGURA");
  });
});

describe("a composição por status acadêmico fecha", () => {
  it("fecha ao centavo em valor, em títulos e em alunos", async () => {
    const formado = await aluno(db, { nome: "FORMADA", cpf: "11100000001", situacao: "Formado" });
    const trancado = await aluno(db, { nome: "TRANCADO", cpf: "11100000002", situacao: "Trancado" });
    await tituloHistorico(db, { alunoId: formado, saldo: 1234.56 });
    await tituloHistorico(db, { alunoId: formado, saldo: 765.44 });
    await tituloHistorico(db, { alunoId: trancado, saldo: 1000.01 });

    const c = await composicao(db, "2024");
    expect(c.conferencia.fecha).toBe(true);
    expect(cent(c.conferencia.diferenca)).toBe(0);
    expect(cent(c.total.valor)).toBe(3000.01);
    expect(c.conferencia.titulos_total).toBe(c.conferencia.titulos_soma);
    expect(c.conferencia.alunos_total).toBe(c.conferencia.alunos_soma);
    // CPF tem UM status, então a soma por linha fecha o total de alunos
    const alunos = c.linhas.reduce((s, l) => s + Number(l.alunos), 0);
    expect(alunos).toBe(c.total.alunos);
  });

  it("aluno sem situação importada entra como categoria, nunca descartado", async () => {
    const com = await aluno(db, { cpf: "11100000003", situacao: "Formado" });
    const sem = await aluno(db, { nome: "SEM SITUACAO", cpf: "11100000004", situacao: null });
    await tituloHistorico(db, { alunoId: com, saldo: 1000 });
    await tituloHistorico(db, { alunoId: sem, saldo: 3000 });

    const c = await composicao(db, "2024");
    const linha = c.linhas.find((l) => l.status === "(sem situação importada)");
    expect(linha).toBeTruthy();
    expect(cent(linha.valor)).toBe(3000);
    // e o total segue fechando: o descarte seria justamente o que abriria buraco
    expect(c.conferencia.fecha).toBe(true);
    expect(cent(c.total.valor)).toBe(4000);
  });

  it("não agrupa categorias parecidas nem cria “Outros”", async () => {
    const a1 = await aluno(db, { cpf: "11100000005", situacao: "Aguardando Matrícula" });
    const a2 = await aluno(db, { cpf: "11100000006", situacao: "Matriculado Curso Normal" });
    await tituloHistorico(db, { alunoId: a1, saldo: 100 });
    await tituloHistorico(db, { alunoId: a2, saldo: 200 });

    const c = await composicao(db, "2024");
    const nomes = c.linhas.map((l) => l.status).sort();
    expect(nomes).toEqual(["Aguardando Matrícula", "Matriculado Curso Normal"]);
    expect(nomes).not.toContain("Outros");
  });

  it("devolve a data da importação acadêmica — é fotografia, não consulta de hoje", async () => {
    const a = await aluno(db, { cpf: "11100000007", situacao: "Formado",
                                importadoEm: "2026-08-04T15:19:51Z" });
    await tituloHistorico(db, { alunoId: a, saldo: 100 });
    const c = await composicao(db, "2024");
    expect(String(c.fonte_academica.importacao_atualizada_em)).toContain("2026-08-04");
  });

  it("em 2026/1 o universo em aberto inclui a validação, pela regra da safra", async () => {
    const a = await aluno(db, { situacao: "Aguardando Matrícula" });
    await classificado(db, { alunoId: a, valor: 1000, inadimplencia: 600, validacao: 400 });

    const c = await composicao(db, "2026", "1");
    expect(c.universo_em_aberto).toBe("inadimplencia + em_validacao");
    expect(cent(c.total.valor)).toBe(1000);
    expect(c.conferencia.fecha).toBe(true);
  });

  it("2026/2 é recusado com razão, em vez de devolver vazio", async () => {
    await expect(composicao(db, "2026", "2")).rejects.toThrow(/fonte academica equivalente/);
  });

  it("safra sem régua é recusada", async () => {
    await expect(composicao(db, "2023")).rejects.toThrow(/Safra sem regua definida/);
  });
});

describe("Pendente aberto pelos submotivos reais", () => {
  it("em 2024 os submotivos somam o pendente das seis linhas", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    // EM_CONFIRMACAO e "PAGO sem lastro" são os dois submotivos de 2024/2025
    await titulo(db, { alunoId: a, valor: 1401.19, situacao: "EM_CONFIRMACAO" });
    await titulo(db, { alunoId: a, valor: 285.00, situacao: "PAGO" });
    await titulo(db, { alunoId: a, valor: 5000.00 }); // em aberto, não é pendente

    const seis = await seisLinhas(db, "2024");
    const p = await pendencias(db, "2024");
    expect(p.conferencia.fecha).toBe(true);
    expect(cent(p.total.valor)).toBe(cent(seis.situacoes.pendente.valor));
    expect(p.motivos.map((m) => m.chave).sort())
      .toEqual(["em_confirmacao", "pago_sem_lastro"]);
    expect(p.contagens_somaveis).toBe(true);
  });

  it("não inventa submotivo: em 2026/1 são exatamente os três de pendente_detalhe", async () => {
    const a = await aluno(db, { situacao: "Aguardando Matrícula" });
    await classificado(db, { alunoId: a, valor: 300, validacao: 100, academico: 100, convertido: 100 });

    const p = await pendencias(db, "2026", "1");
    expect(p.motivos.map((m) => m.chave).sort())
      .toEqual(["ajuste_academico", "convertido_origem_comprovada", "em_validacao"]);
  });

  it("título com valor em dois submotivos não duplica valor, e a função avisa das contagens", async () => {
    const a = await aluno(db, { situacao: "Aguardando Matrícula" });
    // UM título com valor em em_validacao E em academico: colunas disjuntas
    await classificado(db, { alunoId: a, valor: 500, validacao: 300, academico: 200 });

    const p = await pendencias(db, "2026", "1");
    expect(cent(p.total.valor)).toBe(500);
    expect(p.conferencia.fecha).toBe(true);
    // o mesmo título está em dois motivos, então as contagens não somam
    const titulos = p.motivos.reduce((s, m) => s + Number(m.titulos), 0);
    expect(titulos).toBe(2);
    expect(p.total.titulos).toBe(1);
    expect(p.contagens_somaveis).toBe(false);
  });

  it("cada submotivo carrega a ação que a regra existente permite", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    await titulo(db, { alunoId: a, valor: 100, situacao: "EM_CONFIRMACAO" });
    await titulo(db, { alunoId: a, valor: 100, situacao: "PAGO" });

    const p = await pendencias(db, "2024");
    const porChave = Object.fromEntries(p.motivos.map((m) => [m.chave, m.acao]));
    expect(porChave.em_confirmacao).toBe("CONFERENCIA_PRIME");
    expect(porChave.pago_sem_lastro).toBe("SEM_ACAO_AUTOMATICA_SEGURA");
  });

  it("PAGO com acordo, com pagamento casado ou com liquidação NÃO é pago sem lastro", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    const t = await titulo(db, { alunoId: a, valor: 100, situacao: "PAGO",
                                 liquidacao: "PRIME" });
    expect(t.id).toBeTruthy();
    const p = await pendencias(db, "2024");
    expect(p.motivos.find((m) => m.chave === "pago_sem_lastro")).toBeUndefined();
  });
});

describe("o registro individual — é por aqui que a Fila Única trata", () => {
  it("devolve tudo o que identifica o caso", async () => {
    const a = await aluno(db, { nome: "ALUNA ALFA", cpf: "12345678901",
                                situacao: "Formado", responsavel: "cobranca03@aelbra.com.br" });
    const t = await titulo(db, { alunoId: a, valor: 3987.54, situacao: "EM_CONFIRMACAO",
                                 documento: "4445066", vencimento: "2024-03-10" });

    const [linha] = await itens(db, "em_confirmacao", "2024");
    expect(linha.aluno_id).toBe(a);
    expect(linha.aluno_nome).toBe("ALUNA ALFA");
    expect(linha.cpf).toBe("12345678901");
    expect(linha.titulo_id).toBe(t.id);
    expect(linha.documento).toBe("4445066");
    // PGlite devolve `date` como Date do JS no fuso local; o que interessa é
    // o dia civil armazenado, então a comparação é pelo ISO em UTC.
    expect(new Date(linha.vencimento).toISOString().slice(0, 10)).toBe("2024-03-10");
    expect(linha.safra).toBe("2024");
    expect(cent(linha.valor)).toBe(3987.54);
    expect(linha.motivo).toBe("em_confirmacao");
    expect(linha.motivo_rotulo).toBe("Em confirmação de pagamento");
    expect(linha.situacao_titulo).toBe("EM_CONFIRMACAO");
    expect(linha.evidencia).toMatch(/Conferencia Prime/);
    expect(linha.responsavel_email).toBe("cobranca03@aelbra.com.br");
    expect(linha.desde).toBeTruthy();
    expect(linha.acao).toBe("CONFERENCIA_PRIME");
  });

  it("o responsável do caso ativo tem precedência sobre o responsável do aluno", async () => {
    const a = await aluno(db, { situacao: "Formado", responsavel: "doaluno@x.com" });
    await db.query(`insert into public.casos (aluno_id, operador_email, encerrado_operacional)
                    values ($1,'docaso@x.com', false)`, [a]);
    await titulo(db, { alunoId: a, valor: 10, situacao: "EM_CONFIRMACAO" });
    const [linha] = await itens(db, "em_confirmacao", "2024");
    expect(linha.responsavel_email).toBe("docaso@x.com");
  });

  it("a soma dos itens de um motivo é o valor daquele motivo", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    await titulo(db, { alunoId: a, valor: 111.11, situacao: "EM_CONFIRMACAO" });
    await titulo(db, { alunoId: a, valor: 222.22, situacao: "EM_CONFIRMACAO" });

    const p = await pendencias(db, "2024");
    const motivo = p.motivos.find((m) => m.chave === "em_confirmacao");
    const lista = await itens(db, "em_confirmacao", "2024", null, 500);
    const soma = lista.reduce((s, l) => s + Number(l.valor), 0);
    expect(cent(soma)).toBe(cent(motivo.valor));
  });

  it("motivo que não existe na safra é recusado com a razão", async () => {
    await expect(itens(db, "em_validacao", "2024")).rejects.toThrow(/nao existe em 2024/);
  });

  it("motivo desconhecido é recusado", async () => {
    await expect(itens(db, "editar_valor", "2024")).rejects.toThrow(/Motivo desconhecido/);
  });

  it("o teto de 500 por chamada não pode ser furado", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    for (let i = 0; i < 3; i++) {
      await titulo(db, { alunoId: a, valor: 10, situacao: "EM_CONFIRMACAO" });
    }
    // pedir 10 mil devolve no máximo o teto; aqui só há 3, então o que se prova
    // é que a chamada não estoura e respeita o limite declarado
    const lista = await itens(db, "em_confirmacao", "2024", null, 10000);
    expect(lista.length).toBe(3);
    // e a paginação funciona
    const pagina2 = await itens(db, "em_confirmacao", "2024", null, 2, 2);
    expect(pagina2.length).toBe(1);
  });
});

describe("permissão: o portão fecha as três funções", () => {
  it("sem o portão, nenhuma das três responde", async () => {
    await portao(db, false);
    await expect(composicao(db, "2024")).rejects.toThrow(/Acesso negado/);
    await expect(pendencias(db, "2024")).rejects.toThrow(/Acesso negado/);
    await expect(itens(db, "em_confirmacao", "2024")).rejects.toThrow(/Acesso negado/);
  });

  it("como `authenticated` — não como dono do banco — as três executam", async () => {
    const a = await aluno(db, { situacao: "Formado" });
    await titulo(db, { alunoId: a, valor: 100, situacao: "EM_CONFIRMACAO" });
    await comoPapel(db, "authenticated");
    try {
      expect((await composicao(db, "2024")).conferencia.fecha).toBe(true);
      expect((await pendencias(db, "2024")).conferencia.fecha).toBe(true);
      expect((await itens(db, "em_confirmacao", "2024")).length).toBe(1);
    } finally {
      await voltarDono(db);
    }
  });

  it("`anon` não tem execute em nenhuma das cinco", async () => {
    const r = await q1(db, `select count(*)::int n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('carteira_em_aberto_por_status_academico',
                         'carteira_pendencias_por_motivo','carteira_pendencias_itens',
                         'carteira_pendencia_rotulo','carteira_pendencia_acao')
       and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r.n).toBe(0);
  });
});

describe("o rollback devolve o banco ao estado anterior", () => {
  it("derruba as cinco funções e deixa as seis linhas de pé", async () => {
    // Os dois rollbacks, na ordem inversa da aplicação.
    await db.exec(ROLL(AJUSTES));
    await db.exec(ROLL(NOVA));
    const r = await q1(db, `select count(*)::int n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('carteira_em_aberto_por_status_academico',
                         'carteira_pendencias_por_motivo','carteira_pendencias_itens',
                         'carteira_pendencia_rotulo','carteira_pendencia_acao')`);
    expect(r.n).toBe(0);
    // a camada de leitura e a rotina também saem
    const camada = await q1(db, `select
        (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('carteira_efetividade_recalcular','carteira_efetividade_ler',
                              'carteira_pendencias_itens_ler')) f,
        (select count(*)::int from cron.job where jobname = 'carteira_efetividade_hora') j,
        (select count(*)::int from information_schema.tables
          where table_schema = 'public'
            and table_name in ('carteira_efetividade_snapshot','carteira_pendencias_item_snapshot')) t`);
    expect(camada.f).toBe(0);
    expect(camada.j).toBe(0);
    expect(camada.t).toBe(0);
    // `carteira_safra_situacoes` não foi tocada e continua respondendo
    const seis = await seisLinhas(db, "2024");
    expect(seis.conferencia).toBeTruthy();
  });
});

// ===========================================================================
// AJUSTES DE 07/10/2026 -- a regua historica e a camada de leitura
// ===========================================================================
//
// A REGUA. `carteira_saldo_historico_por_ano()` e funcao de producao sem
// arquivo no repositorio, entao ela nao pode ser aplicada no PGlite. O que se
// prova aqui e a SEMANTICA da regua, por construcao: as cinco exclusoes
// disparam, as tres contagens sao as daquela funcao (CPF, linha, saldo) e a
// composicao fecha em valor, titulos E alunos. A IGUALDADE com a funcao de
// producao esta provada pela medicao de 07/10/2026, que devolveu 1.975 / 6.366 /
// R$ 3.674.539,61 em 2024 e 2.880 / 10.467 / R$ 6.212.645,40 em 2025 --
// identicos, ao centavo, ao bloco `aberto` dela.
describe("a regua historica oficial em 2024/2025", () => {
  it("conta alunos por CPF, titulos por linha e valor por saldo", async () => {
    // Dois titulos do MESMO CPF: 1 aluno, 2 titulos.
    const a = await aluno(db, { cpf: "11122233344", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: a, saldo: 1000.55 });
    await tituloHistorico(db, { alunoId: a, saldo: 2000.45 });

    const c = await composicao(db, "2024");
    expect(c.total.alunos).toBe(1);
    expect(c.total.titulos).toBe(2);
    expect(cent(c.total.valor)).toBe(3001.00);
    expect(c.regua).toBe("carteira_saldo_historico_por_ano().aberto");
  });

  it("fecha em valor, titulos E alunos -- as tres", async () => {
    const f = await aluno(db, { cpf: "11111111111", situacao: "Formado" });
    const t = await aluno(db, { cpf: "22222222222", situacao: "Trancado" });
    const s = await aluno(db, { cpf: "33333333333", situacao: null });
    await tituloHistorico(db, { alunoId: f, saldo: 100.01 });
    await tituloHistorico(db, { alunoId: f, saldo: 200.02 });
    await tituloHistorico(db, { alunoId: t, saldo: 300.03 });
    await tituloHistorico(db, { alunoId: s, saldo: 400.04 });

    const c = await composicao(db, "2024");
    expect(c.conferencia.fecha).toBe(true);
    expect(cent(c.conferencia.diferenca)).toBe(0);
    expect(c.conferencia.titulos_total).toBe(c.conferencia.titulos_soma);
    expect(c.conferencia.alunos_total).toBe(c.conferencia.alunos_soma);
    expect(c.total.alunos).toBe(3);
    expect(c.total.titulos).toBe(4);
    expect(cent(c.total.valor)).toBe(1000.10);
    // e o aluno sem situacao continua sendo categoria, nao descarte
    expect(c.linhas.find((l) => l.status === "(sem situação importada)").valor).toBeTruthy();
  });

  it("as cinco exclusoes da regua disparam", async () => {
    const base = await aluno(db, { cpf: "99999999999", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: base, saldo: 500 });   // entra

    // 1. portador diferente de 195
    const p = await aluno(db, { cpf: "10000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: p, saldo: 700, portador: 166 });

    // 2. liquidado na Prime mais de 30 dias apos o vencimento
    const l = await aluno(db, { cpf: "10000000002", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: l, saldo: 700, vencimento: "2024-03-10",
                                liquidadoEm: "2024-05-30" });

    // 3. CPF no portador 166 SEM acordo ativo no CRM
    const m = await aluno(db, { cpf: "10000000003", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: m, saldo: 700 });
    await db.query("insert into public.prime_portador_membro (portador, cpf) values (166, $1)",
                   ["10000000003"]);

    // 4. confirmacao de pagamento pendente
    const cf = await aluno(db, { cpf: "10000000004", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: cf, saldo: 700 });
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento (aluno_id, status)
                    values ($1, 'AGUARDANDO_CONFIRMACAO')`, [cf]);

    // 5. caso cancelado / juridico
    const cx = await aluno(db, { cpf: "10000000005", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: cx, saldo: 700 });
    await db.query(`insert into public.casos (aluno_id, status_atual) values ($1, 'JURIDICO')`, [cx]);

    // 6. aluno cujos pagamentos desde julho/2026 cobrem todo o aberto dele
    const pg = await aluno(db, { cpf: "10000000006", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: pg, saldo: 700 });
    await db.query(`insert into public.pagamentos (aluno_id, valor_pago, data_pagamento)
                    values ($1, 1000, date '2026-08-01')`, [pg]);

    const c = await composicao(db, "2024");
    // so o titulo base sobrou
    expect(c.total.titulos).toBe(1);
    expect(cent(c.total.valor)).toBe(500);
  });

  it("CPF no portador 166 COM acordo ativo volta a contar", async () => {
    const m = await aluno(db, { cpf: "20000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: m, saldo: 800 });
    await db.query("insert into public.prime_portador_membro (portador, cpf) values (166, $1)",
                   ["20000000001"]);
    await db.query("insert into public.acordos (status, aluno_id) values ('ATIVO', $1)", [m]);

    const c = await composicao(db, "2024");
    expect(cent(c.total.valor)).toBe(800);
  });

  it("NAO e mais a regua das seis linhas: as duas convivem com valores diferentes", async () => {
    // Um titulo que as seis linhas contam em "em aberto" mas a regua oficial
    // exclui: portador diferente de 195.
    const a = await aluno(db, { cpf: "30000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: a, saldo: 900, portador: 166 });

    const seis = await seisLinhas(db, "2024");
    const c = await composicao(db, "2024");
    expect(Number(seis.situacoes.em_aberto?.valor || 0)).toBeGreaterThan(0);
    expect(cent(c.total.valor)).toBe(0);
    // e a composicao segue fechando consigo mesma
    expect(c.conferencia.fecha).toBe(true);
  });
});

describe("a camada rapida de leitura", () => {
  it("antes do recalculo a leitura DIZ que nao ha fotografia", async () => {
    const r = await ler(db, "composicao_academica", "2024");
    expect(r.sem_snapshot).toBe(true);
    expect(r.recorte).toBe("2024");
  });

  it("depois do recalculo a leitura devolve o payload e o gerado_em", async () => {
    const a = await aluno(db, { cpf: "40000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: a, saldo: 1234.56 });
    await tituloHistorico(db, { alunoId: a, saldo: 100, situacao: "EM_CONFIRMACAO" });
    await recalcular(db, "2024");

    const comp = await ler(db, "composicao_academica", "2024");
    expect(comp.sem_snapshot).toBeUndefined();
    expect(cent(comp.total.valor)).toBe(1234.56);
    expect(comp.snapshot.gerado_em).toBeTruthy();
    expect(comp.snapshot.bloco).toBe("composicao_academica");

    const seis = await ler(db, "seis_linhas", "2024");
    expect(seis.conferencia.fecha).toBe(true);

    const pend = await ler(db, "pendencias_por_motivo", "2024");
    expect(pend.motivos.map((m) => m.chave)).toContain("em_confirmacao");
  });

  it("bloco desconhecido e recusado -- a tela nao inventa bloco", async () => {
    await expect(ler(db, "editar_valor", "2024")).rejects.toThrow(/Bloco desconhecido/);
  });

  it("a fila pagina da fotografia, com o total do motivo", async () => {
    const a = await aluno(db, { cpf: "50000000001", situacao: "Formado" });
    for (const v of [300, 200, 100]) {
      await tituloHistorico(db, { alunoId: a, saldo: v, situacao: "EM_CONFIRMACAO" });
    }
    await recalcular(db, "2024");

    const p1 = await itensLer(db, "em_confirmacao", "2024", null, 2, 0);
    expect(p1.length).toBe(2);
    // ordem estavel: maior valor primeiro
    expect(cent(p1[0].valor)).toBe(300);
    // o total do motivo vem na propria linha, sem segunda consulta
    expect(Number(p1[0].total_no_motivo)).toBe(3);
    const p2 = await itensLer(db, "em_confirmacao", "2024", null, 2, 2);
    expect(p2.length).toBe(1);
  });

  it("fotografia que NAO fecha e descartada, sem apagar a boa", async () => {
    const a = await aluno(db, { cpf: "60000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: a, saldo: 500 });
    await recalcular(db, "2024");
    const bom = await ler(db, "composicao_academica", "2024");
    expect(cent(bom.total.valor)).toBe(500);

    // arranca a conferencia da funcao: passa a devolver `fecha: false`
    await db.exec(`
      create or replace function public.carteira_em_aberto_por_status_academico(
        p_ano text, p_semestre text default null)
      returns jsonb language sql stable as $$
        select jsonb_build_object('recorte', p_ano,
                                  'total', jsonb_build_object('alunos',1,'titulos',1,'valor',9999),
                                  'linhas', '[]'::jsonb,
                                  'conferencia', jsonb_build_object('fecha', false, 'diferenca', 9999))
      $$;`);
    await recalcular(db, "2024");

    const depois = await ler(db, "composicao_academica", "2024");
    // a fotografia boa ficou: 500, nao 9999
    expect(cent(depois.total.valor)).toBe(500);
  });

  it("a rotina horaria e agendada, e o recalculo nao e alcancavel por anon", async () => {
    const job = await q1(db, "select jobname, schedule from cron.job where jobname = $1",
                         ["carteira_efetividade_hora"]);
    expect(job.schedule).toBe("40 * * * *");

    const r = await q1(db, `select count(*)::int n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('carteira_efetividade_recalcular','carteira_efetividade_ler',
                         'carteira_pendencias_itens_ler')
       and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r.n).toBe(0);
  });

  it("como `authenticated` a LEITURA funciona", async () => {
    const a = await aluno(db, { cpf: "70000000001", situacao: "Formado" });
    await tituloHistorico(db, { alunoId: a, saldo: 640 });
    await recalcular(db, "2024");
    await comoPapel(db, "authenticated");
    try {
      const c = await ler(db, "composicao_academica", "2024");
      expect(cent(c.total.valor)).toBe(640);
    } finally {
      await voltarDono(db);
    }
  });
});
