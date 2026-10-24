// RASTREABILIDADE DA IMPORTACAO DE ACORDOS -- P1, P2 e P3.
//
// PostgreSQL real (PGlite), sobre o corpo de PRODUCAO de `importar_acordos`
// colhido em 23/10/2026, com a migration nova aplicada por cima.
//
// O que este arquivo prova, na ordem que a gestao exigiu:
//   REJEICOES          documento sem digito vira critica, nao desaparece;
//   DUPLICIDADES       titulo que ja existe e acordo sinalizado sao
//                      DUPLICIDADE -- classe propria, nao "erro";
//   IGNORADAS          CPF quitado ha 7 dias e divida ja representada sao
//                      IGNORADA_POR_REGRA -- a protecao funcionando;
//   FALHA DE ARMAZENAMENTO  upload que falha nao derruba nem bloqueia a
//                      importacao, e o arquivo nao-preservado fica DECLARADO
//                      como nulo em vez de passar por preservado;
//   INTEGRIDADE DO LOTE  pedacos somam, reenviar pedaco nao duplica, e o
//                      retorno da importacao carrega o resumo das criticas;
//   ACESSO             CPF sai mascarado, operador nao le nada, authenticated
//                      nao herda TRUNCATE, anon nao executa nada;
//   COMPATIBILIDADE    a importacao limpa continua com os mesmos contadores de
//                      antes, e `registrar_importacao_acordo` segue valida com
//                      os 8 argumentos originais;
//   SEM HISTORICO INVENTADO  aplicar a migration nao cria nenhuma critica
//                      retroativa.
import { describe, it, expect, vi } from "vitest";
import {
  novoBanco, um, todos, linha, importar, criticas, resumo,
  comoImportador, comoGestao, comoOperador, semSessao,
  IMPORTADOR, U, ROLLBACK,
} from "./fixtures/importacao_acordos_rastro/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const LOTE = "11111111-1111-4111-8111-111111111111";
const LOTE2 = "22222222-2222-4222-8222-222222222222";

describe("P2 — rejeicoes", () => {
  it("documento sem digito nenhum vira REJEICAO e nao some", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await importar(db, LOTE, [
      linha({ documento: "050999990001" }),
      linha({ documento: "sem numero", cpf: "11122233344", venc: "2026-09-05", valor: 500 }),
    ]);

    const c = await criticas(db, LOTE);
    const rej = c.filter((x) => x.motivo_codigo === "documento_invalido");
    expect(rej).toHaveLength(1);
    expect(rej[0].classe).toBe("REJEICAO");
    expect(rej[0].origem).toBe("SERVIDOR");
    expect(rej[0].cpf).toBe("11122233344");
    expect(Number(rej[0].valor)).toBe(500);

    // e o titulo valido entrou normalmente: a critica nao barrou a importacao
    const t = await um(db, `select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(1);
  });

  it("a tela reporta a linha COM numero, e e a unica que consegue", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    const r = await um(db, `select public.importacao_acordo_critica_registrar($1::uuid, $2::jsonb) as n`,
      [LOTE, JSON.stringify([
        { linha: 42, documento: "TOTAL", cpf: "99988877766", venc: "", valor: "" },
        { linha: 77, documento: "", cpf: "", venc: "2026-08-07", valor: "10.50" },
      ])]);
    expect(r.n).toBe(2);

    const c = await criticas(db, LOTE);
    expect(c).toHaveLength(2);
    expect(c.every((x) => x.classe === "REJEICAO" && x.origem === "ARQUIVO")).toBe(true);
    expect(c.map((x) => x.linha_numero).sort((a, b) => a - b)).toEqual([42, 77]);
    // o texto CRU da celula fica guardado: e o que distingue linha de total de
    // documento digitado errado na hora da conferencia
    expect(c.find((x) => x.linha_numero === 42).documento).toBe("TOTAL");
    expect(c.find((x) => x.linha_numero === 77).documento).toBeNull();
  });

  it("a tela NAO consegue fabricar duplicidade: a RPC so grava documento_invalido", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await um(db, `select public.importacao_acordo_critica_registrar($1::uuid, $2::jsonb) as n`,
      [LOTE, JSON.stringify([
        { linha: 1, classe: "DUPLICIDADE", motivo_codigo: "titulo_ja_existe", documento: "050999990001" },
      ])]);
    const c = await criticas(db, LOTE);
    expect(c).toHaveLength(1);
    expect(c[0].classe).toBe("REJEICAO");
    expect(c[0].motivo_codigo).toBe("documento_invalido");
  });

  it("quem nao pode importar nao grava critica", async () => {
    const db = await novoBanco();
    await comoOperador(db);
    await expect(
      um(db, `select public.importacao_acordo_critica_registrar($1::uuid, '[]'::jsonb) as n`, [LOTE])
    ).rejects.toThrow(/SEM_PERMISSAO_IMPORTACAO_BORDERO/);
  });
});

describe("P2 — duplicidades", () => {
  it("documento que JA e titulo vira DUPLICIDADE e nao entra de novo", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto)
                   values ('050999990001', 'ABERTO', 'Acordo');`);

    await importar(db, LOTE, [linha({ documento: "050999990001" })]);

    const c = await criticas(db, LOTE);
    const dup = c.filter((x) => x.motivo_codigo === "titulo_ja_existe");
    expect(dup).toHaveLength(1);
    expect(dup[0].classe).toBe("DUPLICIDADE");
    expect(dup[0].documento).toBe("050999990001");

    const t = await um(db, `select count(*)::int n from public.acordos_titulos where documento='050999990001'`);
    expect(t.n).toBe(1);   // continua um: nao duplicou
  });

  it("importacao limpa NAO acusa duplicidade das linhas que ela mesma inseriu", async () => {
    // Este e o cenario que decide o desenho: se a medicao fosse DEPOIS do
    // insert, cada linha inserida casaria com ela mesma e toda importacao
    // sairia 100% duplicada.
    const db = await novoBanco();
    await comoImportador(db);
    await importar(db, LOTE, [
      linha({ documento: "050999990001" }),
      linha({ documento: "050999990002" }),
      linha({ documento: "050999990003" }),
    ]);

    const c = await criticas(db, LOTE);
    expect(c.filter((x) => x.classe === "DUPLICIDADE")).toHaveLength(0);
    const t = await um(db, `select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(3);
  });

  it("acordo sinalizado como duplicado entra com o numero do acordo, sem documento", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    const aluno = U(1);
    await db.exec(`
      insert into public.alunos (id, nome, cpf) values ('${aluno}', 'Aluna Inventada', '03704201014');
      insert into public.acordos (aluno_id, cpf, numero_ulbra, status, duplicado_de, observacao, valor_total)
      values ('${aluno}', '03704201014', '99999', 'ATIVO', '${U(9)}',
              'Importado do Relatorio de Titulos em Aberto (Acordo) — lote ${LOTE}', 100);
    `);

    await importar(db, LOTE, [linha({ documento: "050999990001" })]);

    const c = await criticas(db, LOTE);
    const dup = c.filter((x) => x.motivo_codigo === "acordo_duplicado_sinalizado");
    expect(dup).toHaveLength(1);
    expect(dup[0].classe).toBe("DUPLICIDADE");
    expect(dup[0].acordo_ulbra).toBe("99999");
    expect(dup[0].documento).toBeNull();
    expect(dup[0].cpf).toBe("03704201014");
  });
});

describe("P2 — ignoradas por regra (nao sao erro)", () => {
  it("CPF quitado nos ultimos 7 dias com acordo: IGNORADA_POR_REGRA, com identidade", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    const aluno = U(2);
    await db.exec(`
      insert into public.alunos (id, nome, cpf) values ('${aluno}', 'Quitado Recente', '03704201014');
      insert into public.casos (aluno_id, quitado_em) values ('${aluno}', now() - interval '2 days');
      insert into public.acordos (aluno_id, cpf, status, valor_total) values ('${aluno}', '03704201014', 'QUITADO', 10);
    `);

    const r = await importar(db, LOTE, [
      linha({ documento: "050999990001", cpf: "03704201014" }),
      linha({ documento: "050999990002", cpf: "03704201014" }),
    ]);

    const c = await criticas(db, LOTE);
    const ign = c.filter((x) => x.motivo_codigo === "cpf_quitado_recente");
    expect(ign).toHaveLength(2);
    expect(ign.every((x) => x.classe === "IGNORADA_POR_REGRA")).toBe(true);
    expect(ign.map((x) => x.documento).sort()).toEqual(["050999990001", "050999990002"]);
    // a regra continua valendo: nada foi importado
    expect(r.r.linhas_puladas_quitados).toBe(2);
    const t = await um(db, `select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(0);
  });

  it("divida ja representada por parcela: IGNORADA_POR_REGRA", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.parcelas (boleto, valor) values ('50999990001', 100);`);

    const r = await importar(db, LOTE, [linha({ documento: "050999990001" })]);

    const c = await criticas(db, LOTE);
    const ign = c.filter((x) => x.motivo_codigo === "divida_ja_representada");
    expect(ign).toHaveLength(1);
    expect(ign[0].classe).toBe("IGNORADA_POR_REGRA");
    expect(r.r.linhas_ja_representadas_no_crm).toBe(1);
    const t = await um(db, `select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(0);
  });

  it("as tres naturezas convivem no mesmo lote, cada uma na sua classe", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`
      insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');
      insert into public.parcelas (boleto, valor) values ('50999990002', 50);
    `);
    await importar(db, LOTE, [
      linha({ documento: "050999990001" }),            // DUPLICIDADE
      linha({ documento: "050999990002" }),            // IGNORADA_POR_REGRA
      linha({ documento: "nao tem", cpf: "55566677788" }), // REJEICAO
      linha({ documento: "050999990003" }),            // entra limpo
    ]);

    const r = await resumo(db, LOTE);
    const porClasse = Object.fromEntries(r.map((x) => [x.classe + "/" + x.motivo_codigo, Number(x.total)]));
    expect(porClasse["DUPLICIDADE/titulo_ja_existe"]).toBe(1);
    expect(porClasse["IGNORADA_POR_REGRA/divida_ja_representada"]).toBe(1);
    expect(porClasse["REJEICAO/documento_invalido"]).toBe(1);
  });
});

describe("integridade do lote", () => {
  it("pedacos do mesmo lote SOMAM as criticas", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto)
                   values ('050999990001','ABERTO','Acordo'), ('050999990002','ABERTO','Acordo');`);

    await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    await importar(db, LOTE, [linha({ documento: "050999990002" })]);

    const c = await criticas(db, LOTE);
    expect(c.filter((x) => x.motivo_codigo === "titulo_ja_existe")).toHaveLength(2);
  });

  it("reenviar o MESMO pedaco nao conta a critica duas vezes", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto)
                   values ('050999990001','ABERTO','Acordo');`);

    const lote = [linha({ documento: "050999990001" })];
    await importar(db, LOTE, lote);
    await importar(db, LOTE, lote);
    await importar(db, LOTE, lote);

    const c = await criticas(db, LOTE);
    expect(c.filter((x) => x.motivo_codigo === "titulo_ja_existe")).toHaveLength(1);
  });

  it("critica de lotes diferentes nao se mistura — a unicidade e POR lote", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto)
                   values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    await importar(db, LOTE2, [linha({ documento: "050999990001" })]);

    const c1 = await criticas(db, LOTE);
    const c2 = await criticas(db, LOTE2);
    // o MESMO documento critica nos dois lotes: a unicidade e por lote, nao global
    expect(c1.filter((x) => x.motivo_codigo === "titulo_ja_existe")).toHaveLength(1);
    expect(c2.filter((x) => x.motivo_codigo === "titulo_ja_existe")).toHaveLength(1);
    // e o 2o lote ganha uma critica a mais, por um motivo real: o 1o lote criou
    // o acordo 99999 pela fila, e agora a divida esta representada por ele.
    expect(c1.filter((x) => x.motivo_codigo === "divida_ja_representada")).toHaveLength(0);
    expect(c2.filter((x) => x.motivo_codigo === "divida_ja_representada")).toHaveLength(1);
  });

  it("o retorno da importacao CARREGA o resumo — a tela nao consegue pintar sucesso sem ele", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto)
                   values ('050999990001','ABERTO','Acordo');`);

    const r = await importar(db, LOTE, [
      linha({ documento: "050999990001" }),
      linha({ documento: "invalido", cpf: "12312312312" }),
      linha({ documento: "050999990009" }),
    ]);

    expect(r.r.criticas_total).toBe(2);
    expect(r.r.criticas_por_classe).toEqual({ DUPLICIDADE: 1, REJEICAO: 1 });
  });

  it("lote sem nenhuma critica devolve total zero e objeto vazio", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    const r = await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    expect(r.r.criticas_total).toBe(0);
    expect(r.r.criticas_por_classe).toEqual({});
  });
});

describe("P1 — preservacao do arquivo e falha de armazenamento", () => {
  it("grava path, md5, bytes e linhas da importacao", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await um(db, `select public.registrar_importacao_acordo_arquivo(
                    $1::uuid, 'acordos/${LOTE}/relatorio.xlsx', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2048, 1500, 'relatorio.xlsx', 1200)`,
      [LOTE]);

    const r = await um(db, `select arquivo_path, arquivo_sha256, arquivo_bytes, linhas_arquivo,
                                   linhas_fora_do_escopo, arquivo_nome, importado_por
                              from public.importacoes_acordos where importacao_id = $1`, [LOTE]);
    expect(r.arquivo_path).toBe(`acordos/${LOTE}/relatorio.xlsx`);
    expect(r.arquivo_sha256).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(Number(r.arquivo_bytes)).toBe(2048);
    expect(r.linhas_arquivo).toBe(1500);
    expect(r.linhas_fora_do_escopo).toBe(1200);
    expect(r.importado_por).toBe(IMPORTADOR);
  });

  it("FALHA DE ARMAZENAMENTO: sem path, a linha nasce com o arquivo DECLARADO como nao preservado", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    // a tela chama com path nulo quando o upload falhou -- e segue importando
    await um(db, `select public.registrar_importacao_acordo_arquivo(
                    $1::uuid, null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2048, 1500, 'relatorio.xlsx', null)`, [LOTE]);
    const r = await um(db, `select arquivo_path, arquivo_sha256, linhas_arquivo
                              from public.importacoes_acordos where importacao_id = $1`, [LOTE]);
    expect(r.arquivo_path).toBeNull();      // nulo = nao preservado, e isso fica visivel
    expect(r.arquivo_sha256).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");   // o md5 ainda identifica o arquivo que passou
    expect(r.linhas_arquivo).toBe(1500);

    // e a importacao continua funcionando: armazenamento e auditoria, nao etapa
    const i = await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    expect(i.r.titulos_inseridos).toBe(1);
  });

  it("registrar_importacao_acordo depois NAO apaga os campos do arquivo", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await um(db, `select public.registrar_importacao_acordo_arquivo(
                    $1::uuid, 'acordos/x.xlsx', 'md5x', 10, 20, 'x.xlsx', 5)`, [LOTE]);
    // a MESMA chamada de 8 argumentos do frontend ja publicado
    await um(db, `select public.registrar_importacao_acordo(
                    p_importacao_id => $1::uuid, p_arquivo_nome => 'x.xlsx', p_parcelas => 3,
                    p_acordos => 1, p_cpfs => 1, p_alunos_novos => 0, p_titulos_inseridos => 3,
                    p_total => 99.9)`, [LOTE]);

    const r = await um(db, `select arquivo_path, arquivo_sha256, linhas_arquivo, parcelas, titulos_inseridos, total
                              from public.importacoes_acordos where importacao_id = $1`, [LOTE]);
    expect(r.arquivo_path).toBe("acordos/x.xlsx");
    expect(r.arquivo_sha256).toBe("md5x");
    expect(r.linhas_arquivo).toBe(20);
    expect(r.parcelas).toBe(3);
    expect(r.titulos_inseridos).toBe(3);
    expect(Number(r.total)).toBe(99.9);
  });

  it("quem nao pode importar nao registra arquivo", async () => {
    const db = await novoBanco();
    await comoOperador(db);
    await expect(
      um(db, `select public.registrar_importacao_acordo_arquivo($1::uuid, 'p', 'm', 1, 1, 'n', 1)`, [LOTE])
    ).rejects.toThrow(/SEM_PERMISSAO_IMPORTACAO_BORDERO/);
  });

  it("o bucket nasce privado, com gravar e ler — e sem update nem delete", async () => {
    const db = await novoBanco();
    const b = await um(db, `select public, file_size_limit from storage.buckets where id='importacoes-acordos'`);
    expect(b.public).toBe(false);
    expect(Number(b.file_size_limit)).toBe(52428800);

    const p = await todos(db, `select polname, polcmd from pg_policy
                                where polrelid='storage.objects'::regclass order by polname`);
    expect(p.map((x) => x.polname)).toEqual(
      ["importacao_acordo_arquivo_gravar", "importacao_acordo_arquivo_ler"]);
    // 'a' = INSERT, 'r' = SELECT. Nenhuma de UPDATE ('w') nem DELETE ('d').
    expect(p.map((x) => x.polcmd).sort()).toEqual(["a", "r"]);
  });
});

describe("P3 — consulta, acesso e dado pessoal", () => {
  it("a gestao le com CPF MASCARADO e o nome resolvido por join", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.alunos (id, nome, cpf) values ('${U(3)}', 'Nome Inventado', '03704201014');
                   insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001", cpf: "03704201014" })]);

    await comoGestao(db);
    const r = await todos(db, `select * from public.importacao_acordo_critica_listar($1::uuid)`, [LOTE]);
    const dup = r.find((x) => x.motivo_codigo === "titulo_ja_existe");
    expect(dup.cpf_mascarado).toBe("037.***.***-14");
    expect(dup.nome).toBe("Nome Inventado");
    // o CPF cru nao sai na consulta
    expect(Object.keys(dup)).not.toContain("cpf");
  });

  it("ficha duplicada do mesmo CPF nao multiplica a critica", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.alunos (id, nome, cpf) values
                     ('${U(4)}', 'Ficha A', '03704201014'), ('${U(5)}', 'Ficha B', '03704201014');
                   insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001", cpf: "03704201014" })]);

    await comoGestao(db);
    const r = await todos(db, `select * from public.importacao_acordo_critica_listar($1::uuid)`, [LOTE]);
    expect(r.filter((x) => x.motivo_codigo === "titulo_ja_existe")).toHaveLength(1);
  });

  it("operador comum nao le critica nenhuma", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001" })]);

    await comoOperador(db);
    expect(await todos(db, `select * from public.importacao_acordo_critica_listar($1::uuid)`, [LOTE])).toHaveLength(0);
    expect(await todos(db, `select * from public.importacao_acordo_critica_resumo($1::uuid)`, [LOTE])).toHaveLength(0);
  });

  it("sem sessao tambem nao le", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    await semSessao(db);
    expect(await todos(db, `select * from public.importacao_acordo_critica_listar($1::uuid)`, [LOTE])).toHaveLength(0);
  });

  it("authenticated nao herda TRUNCATE na tabela de critica — so SELECT", async () => {
    const db = await novoBanco();
    const g = await todos(db, `select privilege_type from information_schema.role_table_grants
                                where table_schema='public' and table_name='importacao_acordo_critica'
                                  and grantee='authenticated'`);
    expect(g.map((x) => x.privilege_type)).toEqual(["SELECT"]);
  });

  it("anon nao executa nenhuma das funcoes novas", async () => {
    const db = await novoBanco();
    const r = await todos(db, `select routine_name from information_schema.routine_privileges
                                where routine_schema='public' and grantee='anon'
                                  and routine_name in ('registrar_importacao_acordo_arquivo',
                                        'importacao_acordo_critica_registrar',
                                        'importacao_acordo_critica_listar',
                                        'importacao_acordo_critica_resumo')`);
    expect(r).toHaveLength(0);
  });

  it("a tabela nao guarda nome, unidade nem situacao do aluno", async () => {
    const db = await novoBanco();
    const cols = await todos(db, `select column_name from information_schema.columns
                                   where table_schema='public' and table_name='importacao_acordo_critica'`);
    const nomes = cols.map((c) => c.column_name);
    expect(nomes).not.toContain("nome");
    expect(nomes).not.toContain("unidade");
    expect(nomes).not.toContain("situacao");
  });

  it("o banco recusa par classe/motivo incoerente", async () => {
    const db = await novoBanco();
    await expect(db.exec(`insert into public.importacao_acordo_critica
      (importacao_id, classe, motivo_codigo, origem, documento)
      values ('${LOTE}', 'REJEICAO', 'titulo_ja_existe', 'SERVIDOR', '050999990001')`))
      .rejects.toThrow(/importacao_acordo_critica_par_ck/);
  });
});

describe("ausencia de regressao e historico", () => {
  it("aplicar a migration NAO cria critica retroativa", async () => {
    const db = await novoBanco();
    const n = await um(db, `select count(*)::int n from public.importacao_acordo_critica`);
    expect(n.n).toBe(0);
  });

  it("importacao limpa tem os MESMOS contadores de antes da migration", async () => {
    const lote = [linha({ documento: "050999990001" }), linha({ documento: "050999990002" })];
    const chaves = ["alunos_novos", "titulos_inseridos", "acordos_na_fila",
                    "acordos_duplicados_sinalizados", "cpfs_pulados_quitados",
                    "linhas_puladas_quitados", "linhas_ja_representadas_no_crm"];

    const antes = await novoBanco({ patch: false });
    await comoImportador(antes);
    const a = (await importar(antes, LOTE, lote)).r;

    const depois = await novoBanco();
    await comoImportador(depois);
    const d = (await importar(depois, LOTE, lote)).r;

    for (const k of chaves) expect(d[k]).toBe(a[k]);
    expect(a.criticas_total).toBeUndefined();   // antes nao existia
    expect(d.criticas_total).toBe(0);
  });

  it("o status gravado em importacoes continua o mesmo", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    const i = await um(db, `select status, tipo from public.importacoes where id = $1`, [LOTE]);
    expect(i.status).toBe("Concluída");
    expect(i.tipo).toBe("ACORDOS");
  });

  it("aluno, titulo e acordo continuam nascendo como antes", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await importar(db, LOTE, [linha({ documento: "050999990001", cpf: "03704201014", nome: "Novo Aluno" })]);

    const al = await um(db, `select nome, origem from public.alunos where cpf='03704201014'`);
    expect(al.nome).toBe("Novo Aluno");
    expect(al.origem).toBe("IMPORT_ACORDOS");
    const t = await um(db, `select situacao, status, saldo_corrigido from public.acordos_titulos where documento='050999990001'`);
    expect(t.situacao).toBe("ABERTO");
    expect(Number(t.saldo_corrigido)).toBe(1316.1);
    const ac = await um(db, `select numero_ulbra, status from public.acordos where cpf='03704201014'`);
    expect(ac.numero_ulbra).toBe("99999");
    expect(ac.status).toBe("ATIVO");
  });
});

describe("rollback", () => {
  it("reverte tudo e devolve importar_acordos funcionando sem critica", async () => {
    const db = await novoBanco();
    await comoImportador(db);
    await db.exec(`insert into public.acordos_titulos (documento, situacao, tipo_boleto) values ('050999990001','ABERTO','Acordo');`);
    await importar(db, LOTE, [linha({ documento: "050999990001" })]);
    expect(await criticas(db, LOTE)).toHaveLength(1);

    await db.exec(ROLLBACK);

    const sobrou = await todos(db, `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                                     where n.nspname='public' and c.relname='importacao_acordo_critica'`);
    expect(sobrou).toHaveLength(0);
    const fn = await todos(db, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                 where n.nspname='public' and proname like 'importacao_acordo_critica%'`);
    expect(fn).toHaveLength(0);
    const cols = await todos(db, `select column_name from information_schema.columns
                                   where table_schema='public' and table_name='importacoes_acordos'
                                     and column_name in ('arquivo_path','arquivo_sha256','arquivo_bytes',
                                                         'linhas_arquivo','linhas_fora_do_escopo')`);
    expect(cols).toHaveLength(0);

    // e a importacao volta a funcionar, igual a producao
    await comoImportador(db);
    // serie NOVA de proposito: a 050999990001 ja deixou o acordo 99999 vivo, e
    // a producao (corretamente) pula titulo cuja divida ja esta no acordo.
    const r = await importar(db, LOTE2, [linha({ documento: "050888880001" })]);
    expect(r.r.titulos_inseridos).toBe(1);
    expect(r.r.criticas_total).toBeUndefined();
  });
});
