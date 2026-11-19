// PROVA EM BANCO DESCARTAVEL: revogar EXECUTE de authenticated em uma funcao
// SECURITY DEFINER NAO quebra os caminhos internos (chamadas feitas por outra
// funcao SECURITY DEFINER de dono postgres, e gatilhos dessas funcoes).
//
// Premissa medida no catalogo de producao (15/11/2026, so leitura): todos os
// chamadores de recalcular_situacao_aluno sao SECURITY DEFINER, dono postgres, e
// nenhum front-end chama a funcao por RPC. Este teste replica o desenho com uma
// funcao STUB (nao o corpo real), suficiente para provar a semantica de privilegio.
//
// O QUE NAO PROVA: o corpo real de recalcular_situacao_aluno, nem producao.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

async function bancoComPapeis() {
  const db = new PGlite();
  await db.exec(`
    create role authenticated nologin;
    create role service_role nologin;
    create role anon nologin;
    create table alunos_x (id int primary key, saldo int not null default 0);
    insert into alunos_x values (1, 0);

    -- Funcao interna, como recalcular_situacao_aluno: SECURITY DEFINER, dono postgres.
    create function recalc_stub(p_id int) returns int
      language plpgsql security definer set search_path = public
    as $f$ begin
      update alunos_x set saldo = saldo + 1 where id = p_id;
      return 1;
    end $f$;

    -- Chamador interno por RPC (como as funcoes de acionamento / pagamento).
    create function caller_rpc(p_id int) returns int
      language plpgsql security definer set search_path = public
    as $f$ begin return recalc_stub(p_id); end $f$;
    grant execute on function caller_rpc(int) to authenticated;

    -- Gatilho SECURITY DEFINER que chama a funcao interna (como _trg_recalc_por_*).
    create function trg_recalc() returns trigger
      language plpgsql security definer set search_path = public
    as $f$ begin perform recalc_stub(new.id); return new; end $f$;
    create table gatilho_x (id int primary key);
    create trigger t_recalc after insert on gatilho_x
      for each row execute function trg_recalc();
    grant insert on gatilho_x to authenticated;

    -- Proposta: revogar authenticated (e public/anon) da funcao interna.
    revoke all on function recalc_stub(int) from public, anon, authenticated;
    grant execute on function recalc_stub(int) to service_role;
    grant execute on function caller_rpc(int) to authenticated;
    grant usage on schema public to authenticated, anon, service_role;
    grant select, update on alunos_x to authenticated;
  `);
  return db;
}

describe("revogar EXECUTE de authenticated preserva caminhos internos", () => {
  it("caminho interno por RPC (funcao SECURITY DEFINER de dono postgres) continua funcionando", async () => {
    const db = await bancoComPapeis();
    await db.exec("set role authenticated;");
    const r = await db.query("select caller_rpc(1) as v");
    await db.exec("reset role;");
    expect(r.rows[0].v).toBe(1);
    const s = await db.query("select saldo from alunos_x where id = 1");
    expect(s.rows[0].saldo).toBe(1);
  });

  it("gatilho SECURITY DEFINER que chama a funcao interna continua funcionando para authenticated", async () => {
    const db = await bancoComPapeis();
    await db.exec("set role authenticated; insert into gatilho_x values (1);");
    await db.exec("reset role;");
    const s = await db.query("select saldo from alunos_x where id = 1");
    expect(s.rows[0].saldo).toBe(1);
  });

  it("chamada DIRETA da funcao interna por authenticated falha (a revogacao surte efeito)", async () => {
    const db = await bancoComPapeis();
    await db.exec("set role authenticated;");
    let erro = null;
    try { await db.query("select recalc_stub(1)"); } catch (e) { erro = e; }
    await db.exec("reset role;");
    expect(erro).not.toBeNull();
    expect(String(erro.message)).toMatch(/permission denied/i);
  });

  it("anon nao executa a funcao interna, e service_role executa", async () => {
    const db = await bancoComPapeis();
    const privs = await db.query(`
      select has_function_privilege('anon','recalc_stub(int)','EXECUTE') as anon,
             has_function_privilege('authenticated','recalc_stub(int)','EXECUTE') as auth,
             has_function_privilege('service_role','recalc_stub(int)','EXECUTE') as svc`);
    expect(privs.rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});
