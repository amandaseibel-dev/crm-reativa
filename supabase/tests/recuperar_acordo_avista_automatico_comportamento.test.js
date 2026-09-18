// RECUPERACAO AUTOMATICA DO ACORDO A VISTA -- COMPORTAMENTO, nao estrutura.
//
// Roda a migration REAL num PostgreSQL real (PGlite), sobre a bancada que ja
// carrega os corpos de PRODUCAO conferidos por md5 (previa do a vista, motor de
// baixa, vinculo de titulos, vinculo do pagamento, gatilhos de parcela e
// acordo, importacao e rodada horaria).
//
// O ponto do arquivo: a etapa roda SEM JWT, como o cron e a importacao a
// chamam, e nao pode inventar regra -- quem decide continua sendo a previa do
// botao "Registrar acordo a vista".
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { novoBanco, um, boletoDe, foto } from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const OPERADOR = "cobranca12@aelbra.com.br";
const A = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;
const P = (n) => `00000000-0000-4000-9000-0000000${String(n).padStart(5, "0")}`;

// Um caso de acordo a vista: aluno identificavel por matricula E nome, uma
// mensalidade em aberto, e o pagamento do boleto 0001 -- sem acordo no CRM.
async function semearAvista(db, n, o = {}) {
  const numero = String(n);
  const aluno = o.aluno ?? A(n);
  const cpf = o.cpf ?? `7${numero}00000`.slice(0, 11).padEnd(11, "0");
  const matricula = o.matricula ?? `20260${numero}`;
  const nome = o.nome ?? `ALUNA DE TESTE ${numero}`;
  const valorTitulo = o.valorTitulo ?? 1000;
  const valorPago = o.valorPago ?? 1100; // 1,10 x -- dentro da margem 1,15
  if (!(await um(db, `select count(*)::int from public.usuarios where email = $1`, [OPERADOR]))) {
    await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', $1, 'operador', true)`, [OPERADOR]);
  }
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, saldo_total)
                  values ($1, $2, $3, '***', $4, 'CANOAS', 'AGUARDANDO_BAIXA', $5)`,
    [aluno, nome, cpf, matricula, valorTitulo]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [cpf, matricula]);
  await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido,
                    situacao, status, tipo_boleto)
                  values ($1, $2, $3, '2026-08-05', $4, $4, 'ABERTO', 'em_aberto', 'Cursos de Graduação')`,
    [o.titulo ?? A(n + 1), aluno, `doc${numero}`, valorTitulo]);
  return { aluno, cpf, matricula, nome, valorPago, numero };
}

// O pagamento entra pelo INSERT normal: os gatilhos da importacao rodam.
async function pagar(db, n, c, o = {}) {
  const id = o.id ?? P(n);
  const boleto = o.boleto ?? boletoDe(n, 1);
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, $5, 0, '2026-09-17', $6, 'Operadora', $7, $8)`,
    [id, boleto, JSON.stringify({ vencimento: "2026-09-18", valor_original: c.valorPago }),
      String(n), c.valorPago, OPERADOR, c.nome, c.matricula]);
  return id;
}

const lote = (db, limite = 25) => um(db, `select public.acordo_avista_recuperar_pendentes($1)`, [limite]);
const estado = (db, id) => um(db, `select jsonb_build_object(
    'pagamento', (select p.status_conciliacao from public.pagamentos p where p.id = $1),
    'fila', (select f.decisao from public.fila_pagamento_sem_vinculo f where f.pagamento_id = $1),
    'motivo', (select f.motivo from public.fila_pagamento_sem_vinculo f where f.pagamento_id = $1),
    'acordos', (select count(*) from public.acordos),
    'acordo', (select jsonb_build_object('numero', a.numero_ulbra, 'status', a.status, 'por', a.criado_por_email,
                 'resp', a.operador_responsavel_email)
                 from public.acordos a order by a.criado_em desc limit 1),
    'parcela', (select jsonb_build_object('status', q.status, 'boleto', q.boleto, 'confiavel', q.boleto_confiavel,
                 'ref_ok', q.origem_baixa_ref = $1::text) from public.parcelas q order by q.criado_em desc limit 1),
    'titulos_pagos', (select count(*) from public.acordos_titulos t where upper(coalesce(t.situacao,'')) = 'PAGO'),
    'auditoria', (select count(*) from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'),
    'auditoria_usuario', (select min(usuario) from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'),
    'falhas', (select count(*) from public.auditoria where acao = 'RECUPERACAO_AVISTA_FALHOU'),
    'porta', coalesce(current_setting('reativa.recuperacao_avista', true), '(nao acesa)'))`, [id]);

describe("a etapa desligada não faz nada", () => {
  it("o pagamento entra, fica em AGUARDANDO_ACORDO e nenhum acordo nasce", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c = await semearAvista(db, 71643);
    const id = await pagar(db, 71643, c);
    const e = await estado(db, id);
    expect(e.pagamento).toBe("AGUARDANDO_ACORDO");
    expect(e.acordos).toBe(0);
    expect(e.fila).toBeNull();
    expect(await um(db, `select ligado from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista'`)).toBe(false);
    await db.close();
  });
});

describe("a etapa ligada, sem JWT nenhum (cron e importação)", () => {
  it("a importação já recupera: acordo quitado, parcela paga pelo motor, fila resolvida", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const c = await semearAvista(db, 71643);
    const id = await pagar(db, 71643, c);
    const e = await estado(db, id);
    expect(e.pagamento).toBe("BAIXADO");
    expect(e.fila).toBe("RESOLVIDO_AUTOMATICO");
    expect(e.acordos).toBe(1);
    expect(e.acordo).toEqual({ numero: "71643", status: "QUITADO", por: "conciliacao@sistema", resp: OPERADOR });
    expect(e.parcela).toEqual({ status: "PAGO", boleto: "50716430001", confiavel: true, ref_ok: true });
    expect(e.titulos_pagos).toBe(1);
    expect(e.auditoria).toBe(1);
    expect(e.auditoria_usuario).toBe("conciliacao@sistema");
    // a porta de maquina nao fica acesa depois: dentro da transacao a funcao
    // a apaga, e ao fim da transacao o valor local some de todo jeito
    expect(["off", ""]).toContain(e.porta);
    await db.close();
  });

  it("a rodada horária recupera o que estava pendente, e rodar de novo não cria nada", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c = await semearAvista(db, 71724);
    const id = await pagar(db, 71724, c);
    expect((await estado(db, id)).acordos).toBe(0);

    await db.query(`update public.fluxo_pagamentos_config set ligado = true where etapa = 'recuperar_acordo_avista'`);
    const r1 = await um(db, `select public.fluxo_pagamentos_rodar('teste')`);
    expect(r1.etapas.recuperar_acordo_avista).toMatchObject({ avaliados: 1, recuperados: 1, erros: 0 });

    const depois = await estado(db, id);
    expect(depois.pagamento).toBe("BAIXADO");
    expect(depois.acordos).toBe(1);

    // idempotencia: a selecao nao enxerga mais o pagamento
    const r2 = await lote(db);
    expect(r2).toMatchObject({ avaliados: 0, recuperados: 0, erros: 0 });
    expect((await estado(db, id)).acordos).toBe(1);
    await db.close();
  });
});

describe("recusa: a linha continua na fila, com o motivo específico", () => {
  it("valor acima da margem não recupera, grava o código estável e não decide nada", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const c = await semearAvista(db, 71645, { valorTitulo: 100, valorPago: 342.87 }); // 3,42 x
    const id = await pagar(db, 71645, c);
    const antes = await foto(db);
    const e = await estado(db, id);

    expect(e.pagamento).toBe("AGUARDANDO_ACORDO");
    expect(e.acordos).toBe(0);
    expect(e.fila).toBeNull();
    expect(e.motivo).toMatch(/^ACORDO_AVISTA_DIFERENCA_DENTRO_DA_MARGEM_SEGURA: o valor pago excede a margem de 15% sobre a divida \| /);

    // rodar de novo nao empilha prefixo nem muda nada
    const r = await lote(db);
    expect(r).toMatchObject({ avaliados: 1, recuperados: 0, erros: 0 });
    expect(r.recusados_por_motivo).toEqual({ ACORDO_AVISTA_DIFERENCA_DENTRO_DA_MARGEM_SEGURA: 1 });
    const motivo = (await estado(db, id)).motivo;
    expect(motivo.match(/ACORDO_AVISTA_/g)).toHaveLength(1);
    expect(await foto(db)).toEqual(antes);
    await db.close();
  });

  it("cada bloqueio da prévia vira um código próprio", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    // operador do pagamento fora do cadastro
    const c = await semearAvista(db, 71803);
    await db.query(`delete from public.usuarios where email = $1`, [OPERADOR]);
    const id = await pagar(db, 71803, c);
    expect((await estado(db, id)).motivo).toMatch(/^ACORDO_AVISTA_OPERADOR_CADASTRADO: /);
    await db.close();
  });
});

describe("a seleção só pega o que esta etapa sabe tratar", () => {
  it("boleto que não é a parcela 0001 e acordo que já existe no CRM ficam fora", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const c = await semearAvista(db, 71853);
    await pagar(db, 71853, c, { id: P(1), boleto: boletoDe(71853, 2) }); // 0002
    expect(await lote(db)).toMatchObject({ avaliados: 0, recuperados: 0 });

    // com acordo no CRM o caso e da reconstrucao da parcela paga antes, nao daqui
    const c2 = await semearAvista(db, 71858);
    await db.query(`insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas, criado_por_email)
                    values ($1, '71858', 'ATIVO', 10, 1, 'importacao@sistema')`, [c2.aluno]);
    await pagar(db, 71858, c2, { id: P(2) });
    expect(await lote(db)).toMatchObject({ avaliados: 0, recuperados: 0 });
    await db.close();
  });

  it("o que a gestão já decidiu não volta sozinho", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c = await semearAvista(db, 71876);
    const id = await pagar(db, 71876, c);
    await db.query(`update public.fila_pagamento_sem_vinculo set decisao = 'ENCERRADO_GESTAO' where pagamento_id = $1`, [id]);
    expect(await lote(db)).toMatchObject({ avaliados: 0, recuperados: 0 });
    await db.close();
  });
});

describe("falha de um pagamento não derruba o lote nem a importação", () => {
  it("o erro fica auditado e os outros seguem", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c1 = await semearAvista(db, 71938);
    const id1 = await pagar(db, 71938, c1);
    const c2 = await semearAvista(db, 71956);
    const id2 = await pagar(db, 71956, c2);

    // o registrador quebra no primeiro caso (numero menor sai por ultimo: a
    // ordem e data desc, id asc)
    await db.exec(`create or replace function public.acordo_avista_registrar(
        p_pagamento_id uuid, p_titulo_ids uuid[] default null, p_confirmar boolean default false)
      returns jsonb language plpgsql security definer set search_path to 'public' as $q$
      begin
        if p_pagamento_id = '${id1}'::uuid then raise exception 'falha de teste'; end if;
        return jsonb_build_object('gravou', false, 'ok', false, 'motivo', 'DUBLE');
      end; $q$;`);

    const r = await lote(db);
    expect(r.avaliados).toBe(2);
    expect(r.erros).toBe(1);
    expect(r.recuperados).toBe(0);
    expect(r.recusados_por_motivo).toEqual({ ACORDO_AVISTA_RECUSADO_NA_GRAVACAO: 1 });
    expect((await estado(db, id1)).falhas).toBe(1);
    expect((await estado(db, id2)).pagamento).toBe("AGUARDANDO_ACORDO");
    await db.close();
  });
});

describe("a porta de máquina não abre para a tela", () => {
  it("quem não é da gestão continua barrado no botão, com ou sem a etapa ligada", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const c = await semearAvista(db, 72043);
    const id = await pagar(db, 72043, c);
    // a etapa ja recuperou; o teste aqui e do portao, num pagamento qualquer
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: "cobranca99@aelbra.com.br", role: "authenticated" })]);
    await expect(db.query(`select public.acordo_avista_registrar($1, null, true)`, [id]))
      .rejects.toThrow(/decisão da gestão financeira/);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// PROVAS DE SEGURANCA DA PORTA DE MAQUINA
//
// A pergunta: um `authenticated` comum consegue abrir a porta e mandar o
// sistema criar acordo e dar baixa? As provas abaixo tentam, do jeito mais
// favoravel ao atacante -- inclusive acendendo a chave na SESSAO inteira, o
// que nem por RPC seria possivel.
// ---------------------------------------------------------------------------
describe("a porta de máquina não pode ser forçada por usuário autenticado", () => {
  const acenderNaSessao = (db) => db.exec(`select set_config('reativa.recuperacao_avista', 'on', false)`);

  it("1 e 2. EXECUTE das funções da rotina continua revogado de anon e authenticated", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const perm = await um(db, `select jsonb_build_object(
      'porta_auth', has_function_privilege('authenticated', 'public.acordo_avista_porta_interna()', 'EXECUTE'),
      'porta_anon', has_function_privilege('anon', 'public.acordo_avista_porta_interna()', 'EXECUTE'),
      'um_auth', has_function_privilege('authenticated', 'public.acordo_avista_recuperar_um(uuid,boolean)', 'EXECUTE'),
      'um_anon', has_function_privilege('anon', 'public.acordo_avista_recuperar_um(uuid,boolean)', 'EXECUTE'),
      'lote_auth', has_function_privilege('authenticated', 'public.acordo_avista_recuperar_pendentes(integer)', 'EXECUTE'),
      'lote_anon', has_function_privilege('anon', 'public.acordo_avista_recuperar_pendentes(integer)', 'EXECUTE'))`);
    expect(perm).toEqual({ porta_auth: false, porta_anon: false, um_auth: false, um_anon: false, lote_auth: false, lote_anon: false });

    const c = await semearAvista(db, 72043);
    const id = await pagar(db, 72043, c);
    await expect(db.exec(`set role authenticated; select public.acordo_avista_recuperar_um('${id}'::uuid, true);`))
      .rejects.toThrow(/permission denied for function acordo_avista_recuperar_um/);
    await db.exec(`reset role`);
    await expect(db.exec(`set role authenticated; select public.acordo_avista_recuperar_pendentes(25);`))
      .rejects.toThrow(/permission denied for function acordo_avista_recuperar_pendentes/);
    await db.exec(`reset role`);
    await db.close();
  });

  it("3. acender a chave à mão não abre nenhum dos três portões", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c = await semearAvista(db, 71645);
    const id = await pagar(db, 71645, c);
    const acordoId = await um(db, `insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas)
                                   values ($1, '999999', 'ATIVO', 10, 1) returning id`, [c.aluno]);
    const titulo = await um(db, `select id from public.acordos_titulos where aluno_id = $1`, [c.aluno]);

    await acenderNaSessao(db);
    expect(await um(db, `select current_setting('reativa.recuperacao_avista', true)`)).toBe("on");
    // a chave esta acesa, mas a porta continua fechada fora da rotina
    expect(await um(db, `select public.acordo_avista_porta_interna()`)).toBe(false);

    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: "cobranca99@aelbra.com.br", role: "authenticated", sub: "00000000-0000-4000-8000-000000000001" })]);
    await expect(db.query(`select public.acordo_avista_registrar($1, null, true)`, [id]))
      .rejects.toThrow(/decisão da gestão financeira/);
    await expect(db.query(`select public.pagamento_vincular_aluno($1, $2, 'tentativa')`, [id, c.aluno]))
      .rejects.toThrow(/Vincular pagamento a aluno e decisao da gestao/);
    await db.exec(`reset role`);

    // sem JWT, o vinculo de titulos tambem nao aceita a chave sozinha
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    const vinc = await um(db, `select public.vincular_titulos_acordo($1::uuid[], $2)`, [[titulo], acordoId]);
    expect(vinc).toMatchObject({ ok: false, erro: "NAO_AUTENTICADO" });

    // e nada disso escreveu
    expect(await um(db, `select count(*)::int from public.parcelas`)).toBe(0);
    expect(await um(db, `select status_conciliacao from public.pagamentos where id = $1`, [id])).toBe("AGUARDANDO_ACORDO");
    await db.close();
  });

  it("4 e 5. a chave não fica residual: nem depois do sucesso, nem depois de exceção", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: true });
    const c = await semearAvista(db, 71853);
    const id = await pagar(db, 71853, c);
    expect((await estado(db, id)).pagamento).toBe("BAIXADO"); // rodou pela importacao
    // depois do sucesso, a chave nao esta acesa em lugar nenhum da conexao
    expect(await um(db, `select coalesce(current_setting('reativa.recuperacao_avista', true), '(nao acesa)')`))
      .not.toBe("on");
    expect(await um(db, `select public.acordo_avista_porta_interna()`)).toBe(false);

    // agora com excecao no meio da cadeia
    await db.exec(`create or replace function public.acordo_avista_registrar(
        p_pagamento_id uuid, p_titulo_ids uuid[] default null, p_confirmar boolean default false)
      returns jsonb language plpgsql security definer set search_path to 'public' as $q$
      begin raise exception 'falha de teste no meio da cadeia'; end; $q$;`);
    const c2 = await semearAvista(db, 71858);
    const id2 = await pagar(db, 71858, c2);
    const r = await lote(db);
    expect(r).toMatchObject({ avaliados: 1, recuperados: 0, erros: 1 });
    expect(await um(db, `select coalesce(current_setting('reativa.recuperacao_avista', true), '(nao acesa)')`))
      .not.toBe("on");
    expect(await um(db, `select public.acordo_avista_porta_interna()`)).toBe(false);
    expect((await estado(db, id2)).pagamento).toBe("AGUARDANDO_ACORDO");
    await db.close();
  });

  it("6. depois da exceção, chamada sem contexto interno continua barrada", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const c = await semearAvista(db, 71876);
    const id = await pagar(db, 71876, c);
    // uma passada que quebra no meio
    await db.exec(`create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
      returns jsonb language plpgsql security definer set search_path to 'public' as $q$
      begin raise exception 'falha de teste no vinculo'; end; $q$;`);
    expect(await lote(db)).toMatchObject({ erros: 1, recuperados: 0 });

    // e agora, com a chave acesa na sessao, por fora
    await acenderNaSessao(db);
    await db.exec(`set role authenticated`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: "cobranca99@aelbra.com.br", role: "authenticated", sub: "00000000-0000-4000-8000-000000000001" })]);
    await expect(db.query(`select public.acordo_avista_registrar($1, null, true)`, [id]))
      .rejects.toThrow(/decisão da gestão financeira/);
    await db.exec(`reset role`);
    expect(await um(db, `select count(*)::int from public.acordos`)).toBe(0);
    await db.close();
  });

  it("7. o botão da gestão continua com as mesmas permissões e o mesmo portão", async () => {
    const db = await novoBanco({ patch: true, encerrar: true, avista: true });
    const perm = await um(db, `select jsonb_build_object(
      'registrar_auth', has_function_privilege('authenticated', 'public.acordo_avista_registrar(uuid,uuid[],boolean)', 'EXECUTE'),
      'registrar_anon', has_function_privilege('anon', 'public.acordo_avista_registrar(uuid,uuid[],boolean)', 'EXECUTE'),
      'vincular_aluno_auth', has_function_privilege('authenticated', 'public.pagamento_vincular_aluno(uuid,uuid,text)', 'EXECUTE'),
      'vincular_titulos_auth', has_function_privilege('authenticated', 'public.vincular_titulos_acordo(uuid[],uuid)', 'EXECUTE'),
      'previa_auth', has_function_privilege('authenticated', 'public.acordo_avista_previa(uuid,uuid[])', 'EXECUTE'))`);
    expect(perm).toEqual({ registrar_auth: true, registrar_anon: false, vincular_aluno_auth: true,
      vincular_titulos_auth: true, previa_auth: false });

    // e a gestao continua registrando pelo botao, sem chave nenhuma
    const c = await semearAvista(db, 71938);
    const id = await pagar(db, 71938, c);
    await db.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ email: "amanda.seibel@aelbra.com.br", role: "authenticated", sub: "00000000-0000-4000-8000-000000000002" })]);
    const titulos = await um(db, `select array_agg(id) from public.acordos_titulos where aluno_id = $1`, [c.aluno]);
    const r = await um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [id, titulos]);
    expect(r).toMatchObject({ ok: true, modo: "CONFIRMADO", gravou: true });
    expect(await um(db, `select criado_por_email from public.acordos limit 1`)).toBe("amanda.seibel@aelbra.com.br");
    await db.close();
  });
});
