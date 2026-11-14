// RETORNO AGENDADO: APARECE NO DIA MARCADO E, TRATADO, NAO VOLTA
// =============================================================================
// Defeito relatado em 13/11/2026: o operador agenda retorno com uma aluna para
// um dia e uma hora; o aviso "Hora do retorno" reaparece TODOS os dias, na
// mesma hora, mesmo depois do "Ja falei".
//
// Este teste percorre o caminho inteiro, dia apos dia, num PostgreSQL real
// (PGlite), NOS DOIS ESTADOS:
//   antes  = corpo de producao como esta -> o teste REPRODUZ a repeticao;
//   depois = o mesmo corpo + o SQL pendente -> a repeticao some.
//
// O QUE E REAL AQUI:
//   * `recalcular_situacao_aluno`: copia byte a byte de producao (19/09/2026),
//     supabase/tests/fixtures/recalcular_situacao_aluno_prod_20260919.sql;
//   * o gatilho `trg_aluno_reset_retorno_confirmado` e a RPC
//     `agenda_confirmar_retorno`: executados a partir do arquivo da migration
//     20260808150000;
//   * o SQL pendente e o rollback: executados a partir dos arquivos;
//   * a decisao da tela: as funcoes puras que o PainelCarteira usa de verdade
//     (`retornosAgendados`, `retornosAtrasados`, `retornoParaAvisar`).
//
// A FRONTEIRA, declarada:
//   * o corpo de producao mudou depois de 19/09 (o md5 medido em 22/10 e
//     outro) e o conector de leitura estava fora do ar em 13/11. O ramo
//     COBRANCA_VENCIDA usado aqui e o do ultimo corpo versionado; se o vivo
//     for diferente, a trava de ancora do SQL RECUSA -- ha teste disso;
//   * as funcoes auxiliares (`calibragem_nivel_criticidade`, `fmt_brl`,
//     `dia_util_anterior_ou_igual`, `titulo_superado_por_acordo`) sao dubles:
//     nenhuma decide data nem origem de retorno;
//   * a virada diaria entra como "recalcular todos os alunos", que e o que ela
//     faz para cobranca vencida;
//   * "o dia seguinte" e simulado recuando um dia TODAS as datas gravadas (com
//     os gatilhos desligados so durante o recuo). A funcao usa `current_date`;
//     recuar o dado e mover o relogio sao a mesma coisa para ela. `hoje`, na
//     tela, e lido do proprio banco -- o teste nao depende do fuso da maquina.
//
// NENHUM DADO REAL: nomes, telefones e ids inventados.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retornosAgendados, retornosAtrasados, JANELA_RETORNOS_DIAS } from "../../src/utils/painelMeuDia";
import { retornoParaAvisar } from "../../src/utils/alarmeRetorno";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, "..", ...p), "utf8");

const NOME = "20261113120000_retorno_tratado_nao_herda_selo_do_operador";
const PENDENTE = ler("aguardando_aprovacao", `${NOME}.sql.pendente`);
const ROLLBACK = ler("aguardando_aprovacao", `${NOME}.rollback.sql`);
const CORPO_PROD = ler("tests", "fixtures", "recalcular_situacao_aluno_prod_20260919.sql");
const AGENDA_CONFIRMADO = ler("migrations", "20260808150000_agenda_retorno_confirmado.sql");

function trechoEntre(sql, tag) {
  const m = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!m) throw new Error(`delimitador $${tag}$ nao encontrado`);
  return m[1];
}
const ANCORA = trechoEntre(PENDENTE, "a");
const TROCA = trechoEntre(PENDENTE, "n");
const vezes = (texto, trecho) => texto.split(trecho).length - 1;
const semComentarios = (t) =>
  t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

const OPERADOR = "operador.teste@exemplo.local";
const ALUNA = "a1000000-0000-4000-8000-000000000001";
const OUTRA = "a1000000-0000-4000-8000-000000000002";

const ESQUEMA = `
  create role authenticated;
  create schema auth;
  create function auth.email() returns text language sql stable
    as $$ select nullif(current_setting('teste.email', true), '') $$;

  create table public.alunos (
    id uuid primary key,
    nome text,
    telefone text,
    responsavel_atual_email text,
    status_baixa_pagamento text,
    status_acionamento text,
    data_ultimo_acionamento timestamptz,
    data_retorno date,
    hora_retorno text,
    retorno_origem text,
    retorno_prioritario boolean default false,
    nivel_criticidade text,
    situacao_operacional text,
    proxima_acao text,
    saldo_vencido numeric,
    saldo_total numeric,
    valor_em_aberto numeric
  );
  create table public.casos (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid,
    status_termo text default 'Sem termo',
    termo_status_validacao text,
    criticidade text,
    situacao_operacional text,
    proxima_acao_automatica text,
    proximo_vencimento date,
    parcela_a_vencer numeric,
    parcelas_vencidas int,
    saldo_vencido numeric,
    saldo_total numeric,
    data_retorno date,
    caso_atualizado_em timestamptz
  );
  create table public.acordos (id uuid primary key, aluno_id uuid, status text);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(),
    acordo_id uuid, numero int, valor numeric, vencimento date, status text, is_entrada boolean
  );
  create table public.acordos_titulos (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid, situacao text, status text, tipo_boleto text, vencimento date,
    valor_cobranca_ajustado numeric, saldo_corrigido numeric, valor_em_aberto numeric, valor_original numeric
  );
  create table public.acordo_titulo_vinculo (titulo_id uuid, acordo_id uuid, ativo boolean default true);
  create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  create table public.calibragem_parametros (chave text primary key, valor jsonb);
  create table public.retorno_acordo_auto (
    aluno_id uuid, proximo_vencimento date, data_retorno date, valor numeric, lote text,
    gerado_em timestamptz default now(), unique (aluno_id, proximo_vencimento)
  );
  -- o historico do atendimento: nada neste fluxo pode toca-lo
  create table public.movimentacoes (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid, descricao text, data_retorno date, criado_em timestamptz default now()
  );

  -- dubles: nenhum decide data nem origem de retorno
  create function public.titulo_superado_por_acordo(uuid, date) returns boolean language sql as $$ select false $$;
  create function public.calibragem_nivel_criticidade(int, int, numeric, boolean, boolean, jsonb)
    returns text language sql as $$ select 'ATENCAO'::text $$;
  create function public.fmt_brl(numeric) returns text language sql as $$ select 'R$ ' || $1::text $$;
  create function public.dia_util_anterior_ou_igual(date) returns date language sql as $$ select $1 $$;
`;

async function montar({ corrigido }) {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  await db.exec(AGENDA_CONFIRMADO);
  await db.exec(CORPO_PROD);
  await db.exec("grant execute on function public.recalcular_situacao_aluno(uuid, text) to authenticated;");
  if (corrigido) await db.exec(PENDENTE);

  // Duas alunas com mensalidade vencida (COBRANCA_VENCIDA), acionadas ha dias.
  for (const [id, nome] of [
    [ALUNA, "Aluna Ficticia Um"],
    [OUTRA, "Aluna Ficticia Dois"],
  ]) {
    await db.query(
      `insert into public.alunos (id, nome, telefone, responsavel_atual_email, data_ultimo_acionamento)
       values ($1, $2, '(51) 90000-0000', $3, now() - interval '3 days')`,
      [id, nome, OPERADOR]
    );
    await db.query(`insert into public.casos (aluno_id) values ($1)`, [id]);
    await db.query(
      `insert into public.acordos_titulos (aluno_id, situacao, status, tipo_boleto, vencimento, valor_original)
       values ($1, 'ABERTO', 'aberta', 'Mensalidade', current_date - 40, 500)`,
      [id]
    );
    await db.query(
      `insert into public.movimentacoes (aluno_id, descricao, data_retorno)
       values ($1, 'Contato com sucesso. Retorno combinado.', current_date)`,
      [id]
    );
  }
  await recalcularTodos(db);
  return db;
}

const recalcularTodos = (db) =>
  db.exec("select public.recalcular_situacao_aluno(id, 'virada_teste') from public.alunos;");

// O operador digita a data e a hora na tabulacao: a tela grava data, hora e
// origem OPERADOR juntas (`camposDeRetorno`).
const agendar = (db, id, dias, hora) =>
  db.query(
    `update public.alunos
        set data_retorno = current_date + $2::int, hora_retorno = $3, retorno_origem = 'OPERADOR'
      where id = $1`,
    [id, dias, hora]
  );

// "Ja falei": a tela chama a RPC como o dono do caso.
async function jaFalei(db, id) {
  await db.query("select set_config('teste.email', $1, false)", [OPERADOR]);
  await db.query("select public.agenda_confirmar_retorno($1, true)", [id]);
  await db.query("update public.alunos set retorno_prioritario = false where id = $1", [id]);
}

// Passa um dia e roda a virada diaria.
async function amanhece(db) {
  await db.exec(`
    alter table public.alunos disable trigger user;
    update public.alunos
       set data_retorno = data_retorno - 1,
           data_ultimo_acionamento = data_ultimo_acionamento - interval '1 day',
           retorno_confirmado_em = retorno_confirmado_em - interval '1 day';
    update public.acordos_titulos set vencimento = vencimento - 1;
    update public.movimentacoes set data_retorno = data_retorno - 1, criado_em = criado_em - interval '1 day';
    alter table public.alunos enable trigger user;
  `);
  await recalcularTodos(db);
}

// O que a tela do operador enxerga agora, pelas funcoes puras de verdade.
async function tela(db, horaAgora) {
  const { rows } = await db.query(
    `select id::text as id, nome, telefone, responsavel_atual_email,
            data_retorno::text as data_retorno, hora_retorno, retorno_origem, retorno_prioritario,
            retorno_confirmado_em::text as retorno_confirmado_em,
            situacao_operacional, (data_retorno = current_date) as retorno_e_hoje,
            current_date::text as hoje
       from public.alunos order by nome`
  );
  const hoje = rows[0].hoje;
  const semana = retornosAgendados(rows, hoje, JANELA_RETORNOS_DIAS);
  return {
    hoje,
    linha: (id) => rows.find((r) => r.id === id),
    semana,
    deHoje: semana.filter((r) => r.data === hoje),
    atrasados: retornosAtrasados(rows, hoje),
    // silenciados vazio: a memoria do navegador e por dia e nao vale amanha
    aviso: retornoParaAvisar(semana, { hoje, horaAgora, silenciados: new Map() }),
  };
}

const md5Corpo = async (db) =>
  (
    await db.query(
      "select md5(prosrc) as m from pg_proc where oid = 'public.recalcular_situacao_aluno(uuid,text)'::regprocedure"
    )
  ).rows[0].m;

const historico = async (db) =>
  (await db.query("select count(*)::int as n, md5(string_agg(descricao, '|' order by aluno_id)) as m from public.movimentacoes")).rows[0];

describe("defeito reproduzido: corpo de producao como esta", () => {
  it("o aviso toca no dia marcado, some com 'Ja falei' -- e VOLTA nos tres dias seguintes, na mesma hora", async () => {
    const db = await montar({ corrigido: false });
    await agendar(db, ALUNA, 0, "14:30");

    // Dia marcado, antes da hora: nada. Na hora: toca.
    expect((await tela(db, "14:29")).aviso).toBeNull();
    expect((await tela(db, "14:30")).aviso?.id).toBe(ALUNA);

    await jaFalei(db, ALUNA);
    const feito = await tela(db, "14:31");
    expect(feito.aviso).toBeNull();
    expect(feito.linha(ALUNA).retorno_confirmado_em).not.toBeNull();

    for (const dia of [1, 2, 3]) {
      await amanhece(db);
      const t = await tela(db, "14:30");
      const a = t.linha(ALUNA);
      // a maquina redatou para hoje, manteve o selo e a hora, e apagou o "Ja falei"
      expect(`dia+${dia}:${a.retorno_e_hoje}:${a.retorno_origem}:${a.hora_retorno}`).toBe(`dia+${dia}:true:OPERADOR:14:30`);
      expect(a.retorno_confirmado_em).toBeNull();
      // ...e a tela avisa de novo, como se fosse combinado de hoje
      expect(`dia+${dia}:${t.aviso?.id}`).toBe(`dia+${dia}:${ALUNA}`);
    }
  });
});

describe("corrigido: corpo de producao + SQL pendente", () => {
  it("tratado no dia marcado, nao reaparece em nenhum dos tres dias seguintes", async () => {
    const db = await montar({ corrigido: true });
    await agendar(db, ALUNA, 0, "14:30");

    expect((await tela(db, "14:29")).aviso).toBeNull();
    expect((await tela(db, "14:30")).aviso?.id).toBe(ALUNA);

    await jaFalei(db, ALUNA);
    const feito = await tela(db, "18:00");
    expect(feito.aviso).toBeNull();
    // no proprio dia ele continua na lista, marcado como tratado
    expect(feito.deHoje.map((r) => `${r.id}:${r.tratado}`)).toEqual([`${ALUNA}:true`]);

    for (const dia of [1, 2, 3]) {
      await amanhece(db);
      for (const hora of ["14:30", "23:59"]) {
        const t = await tela(db, hora);
        expect(`dia+${dia} ${hora}:${t.aviso}`).toBe(`dia+${dia} ${hora}:null`);
        expect(t.semana).toEqual([]);
        expect(t.atrasados).toEqual([]);
      }
      // o caso NAO sai da fila: segue em cobranca vencida com prazo de hoje
      const a = (await tela(db, "09:00")).linha(ALUNA);
      expect(`dia+${dia}:${a.situacao_operacional}:${a.retorno_e_hoje}:${a.retorno_origem}`).toBe(
        `dia+${dia}:COBRANCA_VENCIDA:true:AUTOMATICO`
      );
    }
  });

  it("no dia marcado o recalculo nao mexe no combinado nem apaga o 'Ja falei'", async () => {
    const db = await montar({ corrigido: true });
    await agendar(db, ALUNA, 0, "10:00");
    await recalcularTodos(db); // evento qualquer no proprio dia
    expect((await tela(db, "10:00")).aviso?.id).toBe(ALUNA);

    await jaFalei(db, ALUNA);
    await recalcularTodos(db);
    const t = await tela(db, "10:05");
    const a = t.linha(ALUNA);
    expect(`${a.retorno_e_hoje}:${a.retorno_origem}:${a.hora_retorno}`).toBe("true:OPERADOR:10:00");
    expect(a.retorno_confirmado_em).not.toBeNull();
    expect(t.aviso).toBeNull();
  });

  it("retorno futuro e preservado pelas viradas e avisa no dia marcado, na hora", async () => {
    const db = await montar({ corrigido: true });
    await agendar(db, ALUNA, 2, "09:15");

    // hoje e amanha: na semana, sem aviso
    for (let dia = 0; dia < 2; dia += 1) {
      const t = await tela(db, "09:15");
      expect(`dia+${dia}:${t.aviso}`).toBe(`dia+${dia}:null`);
      expect(t.semana.map((r) => r.id)).toEqual([ALUNA]);
      expect(t.linha(ALUNA).retorno_origem).toBe("OPERADOR");
      await amanhece(db);
    }
    // o dia marcado
    expect((await tela(db, "09:14")).aviso).toBeNull();
    expect((await tela(db, "09:15")).aviso?.id).toBe(ALUNA);
  });

  it("retorno NAO tratado fica exatamente como era: segue como combinado ate alguem tratar", async () => {
    // Decisao da gestao em aberto (cabecalho do SQL). O patch nao pode mudar
    // isto por tabela: mesmo roteiro, mesmo resultado, com e sem o patch.
    const visto = [];
    for (const corrigido of [false, true]) {
      const db = await montar({ corrigido });
      await agendar(db, ALUNA, 0, "09:15");
      const linha = [];
      for (const dia of [1, 2]) {
        await amanhece(db);
        const t = await tela(db, "09:15");
        const a = t.linha(ALUNA);
        linha.push(`dia+${dia}:${a.retorno_e_hoje}:${a.retorno_origem}:${a.hora_retorno}:${t.aviso?.id}`);
      }
      // tratado no terceiro dia: ai sim deixa de voltar (so com o patch)
      await jaFalei(db, ALUNA);
      await amanhece(db);
      linha.push(`depois de tratar:${(await tela(db, "09:15")).aviso?.id ?? null}`);
      visto.push(linha);
    }
    const [antes, depois] = visto;
    expect(antes.slice(0, 2)).toEqual([`dia+1:true:OPERADOR:09:15:${ALUNA}`, `dia+2:true:OPERADOR:09:15:${ALUNA}`]);
    expect(depois.slice(0, 2)).toEqual(antes.slice(0, 2));
    expect(antes[2]).toBe(`depois de tratar:${ALUNA}`);
    expect(depois[2]).toBe("depois de tratar:null");
  });

  it("aviso novo so com agendamento novo -- e o novo agendamento avisa", async () => {
    const db = await montar({ corrigido: true });
    await agendar(db, ALUNA, 0, "14:30");
    await jaFalei(db, ALUNA);
    await amanhece(db);
    expect((await tela(db, "14:30")).aviso).toBeNull();

    // o operador marca outro retorno, para daqui a dois dias, noutra hora
    await agendar(db, ALUNA, 2, "08:00");
    const marcado = await tela(db, "08:00");
    expect(marcado.aviso).toBeNull();
    expect(marcado.linha(ALUNA).retorno_confirmado_em).toBeNull(); // nasce pendente

    await amanhece(db);
    expect((await tela(db, "08:00")).aviso).toBeNull();
    await amanhece(db);
    const noDia = await tela(db, "08:00");
    expect(noDia.aviso?.id).toBe(ALUNA);
    expect(noDia.aviso?.hora_retorno).toBe("08:00");
  });

  it("os demais retornos e o historico ficam intactos", async () => {
    const db = await montar({ corrigido: true });
    const antes = await historico(db);
    await agendar(db, ALUNA, 0, "14:30");
    await agendar(db, OUTRA, 3, "16:00");
    await jaFalei(db, ALUNA);

    for (const dia of [1, 2]) {
      await amanhece(db);
      const t = await tela(db, "16:00");
      // a outra aluna segue com o combinado dela, pendente, sem aviso antes da hora
      const o = t.linha(OUTRA);
      expect(`dia+${dia}:${o.retorno_origem}:${o.hora_retorno}:${o.retorno_confirmado_em}`).toBe(`dia+${dia}:OPERADOR:16:00:null`);
      expect(t.semana.map((r) => r.id)).toEqual([OUTRA]);
      expect(t.aviso).toBeNull();
    }
    await amanhece(db);
    expect((await tela(db, "16:00")).aviso?.id).toBe(OUTRA);

    expect(await historico(db)).toEqual(antes);
  });
});

describe("o SQL pendente: so a ancora se move", () => {
  it("a ancora existe exatamente uma vez no ultimo corpo de producao versionado, e a troca nao existe", () => {
    expect(vezes(CORPO_PROD, ANCORA)).toBe(1);
    expect(vezes(CORPO_PROD, TROCA)).toBe(0);
    // a troca muda UMA atribuicao: o resto do ramo e identico
    const linhasAncora = ANCORA.split("\n");
    const linhasTroca = TROCA.split("\n");
    expect(linhasTroca.slice(0, 5)).toEqual(linhasAncora.slice(0, 5));
    expect(linhasTroca.at(-1)).toBe(linhasAncora.at(-1));
  });

  it("desfazendo a troca, o corpo volta byte a byte; dono, definer, config e grants nao mudam", async () => {
    const db = await montar({ corrigido: false });
    const foto = async () =>
      (
        await db.query(
          `select prosrc, proowner::text as dono, prosecdef, coalesce(proconfig::text,'') as config, coalesce(proacl::text,'') as acl
             from pg_proc where oid = 'public.recalcular_situacao_aluno(uuid,text)'::regprocedure`
        )
      ).rows[0];
    const antes = await foto();
    await db.exec(PENDENTE);
    const depois = await foto();

    expect(vezes(depois.prosrc, TROCA)).toBe(1);
    expect(depois.prosrc.split(TROCA).join(ANCORA)).toBe(antes.prosrc);
    expect({ ...depois, prosrc: "" }).toEqual({ ...antes, prosrc: "" });
    expect(antes.prosecdef).toBe(true);
    expect(antes.config).toContain("search_path=public");
    expect(antes.acl).toContain("authenticated=X");
  });

  it("e idempotente: a segunda aplicacao nao muda nada", async () => {
    const db = await montar({ corrigido: true });
    const m = await md5Corpo(db);
    await db.exec(PENDENTE);
    expect(await md5Corpo(db)).toBe(m);
  });

  it("recusa, sem tocar em nada, quando o corpo vivo nao e o que foi lido", async () => {
    const db = await montar({ corrigido: false });
    // producao derivou: alguem mexeu exatamente no ramo
    await db.exec(CORPO_PROD.replace("v_retorno := hoje;", "v_retorno := hoje + 0;"));
    const m = await md5Corpo(db);
    await expect(db.exec(PENDENTE)).rejects.toThrow(/ANCORA NAO BATE/);
    // o `begin` do arquivo ficou aberto e abortado: nada foi gravado
    await db.exec("rollback;");
    expect(await md5Corpo(db)).toBe(m);
  });

  it("o rollback devolve o corpo original e tambem e idempotente", async () => {
    const db = await montar({ corrigido: false });
    const original = await md5Corpo(db);
    await db.exec(ROLLBACK); // nada aplicado ainda: nao faz nada
    expect(await md5Corpo(db)).toBe(original);

    await db.exec(PENDENTE);
    expect(await md5Corpo(db)).not.toBe(original);
    await db.exec(ROLLBACK);
    expect(await md5Corpo(db)).toBe(original);
  });

  it("zero DML e nenhum cron: o SQL e o rollback so trocam a definicao da funcao", () => {
    for (const sql of [PENDENTE, ROLLBACK]) {
      const corpo = semComentarios(sql);
      expect(corpo).not.toMatch(/\b(insert\s+into|delete\s+from|truncate|drop\s+|alter\s+table|grant\s+|revoke\s+)/i);
      expect(corpo).not.toMatch(/\bupdate\s+(public\.)?[a-z_]+\s+set\b/i);
      expect(corpo).not.toMatch(/\bcron\./i);
      expect(corpo).toMatch(/pg_get_functiondef/);
    }
    // o rollback e o espelho exato: a ancora de um e a troca do outro
    expect(trechoEntre(ROLLBACK, "a")).toBe(TROCA);
    expect(trechoEntre(ROLLBACK, "n")).toBe(ANCORA);
  });
});
