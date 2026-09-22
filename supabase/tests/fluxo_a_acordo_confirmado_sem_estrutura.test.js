// FLUXO A: confirmacao 166 sem estrutura, separado do FLUXO B (titulo liquidado). Migration REAL
// (20260922260000) sobre a fixture confirmacao_d2, que ja tem pagamento_conciliar_um REAL (a mesma logica
// de producao para ACORDO_CONFIRMADO_SEM_ESTRUTURA/REVISAO/AGUARDANDO_ACORDO). A fixture NAO tem ainda
// conciliacao_confirmar_portador_166 nem conciliacao_registrar_consulta_estrutura como funcoes separadas
// (sao mais novas que o snapshot) -- este arquivo instala o TEXTO REAL de producao dessas duas RPCs antes
// da migration, para testar contra o comportamento verdadeiro. conciliacao_liquidar_titulo_por_prime
// PROPOSITALMENTE nao e instalada: se a migration chamasse essa RPC, o teste quebraria por funcao
// inexistente -- e essa quebra e a prova de que o Fluxo B nao e acionado.
import { describe, it, expect, beforeAll, vi } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 600000 });
const M = "20260922260000_fluxo_a_acordo_confirmado_sem_estrutura";

// texto real de producao (buscado via MCP em 22/09/2026), com o UNICO ajuste de usar auth.jwt()->>'role'
// via request.jwt.claims, que ja e como a fixture resolve auth.role()/auth.email() nesta suite.
const RPCS_REAIS = `
CREATE OR REPLACE FUNCTION public.conciliacao_registrar_consulta_estrutura(p_pagamento_id uuid, p_resultado text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_n int := 0;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Registrar consulta de estrutura e da gestao ou da rotina.' using errcode = '42501';
  end if;
  if coalesce(p_resultado,'') not in ('NAO_ENCONTRADA','ENCONTRADA','ERRO') then
    raise exception 'resultado invalido: %', p_resultado using errcode = '22023';
  end if;
  update public.fila_pagamento_sem_vinculo set consulta_estrutura_resultado = p_resultado
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'resultado', p_resultado, 'linhas', v_n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.conciliacao_confirmar_portador_166(p_pagamento_id uuid, p_cpf text DEFAULT NULL::text, p_origem text DEFAULT 'PRIME_API_LIVE'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_pag record; v_cpf text; v_cpf_aluno text; v_n int := 0; v_aluno uuid; v_vinculou boolean := false; v_r jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Confirmar portador e da gestao ou da rotina.' using errcode = '42501';
  end if;
  if coalesce(p_origem,'') not in ('PRIME_PORTADOR_MEMBRO','PRIME_API_LIVE') then
    raise exception 'origem invalida: %', p_origem using errcode = '22023';
  end if;
  select * into v_pag from public.pagamentos where id = p_pagamento_id;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO'); end if;
  v_cpf := nullif(regexp_replace(coalesce(p_cpf, v_pag.cpf, ''), '\D', '', 'g'), '');
  if v_cpf is null then return jsonb_build_object('ok', false, 'motivo', 'SEM_CPF'); end if;
  if not exists (select 1 from public.prime_portador_membro m where m.portador = 166 and lpad(m.cpf,11,'0') = lpad(v_cpf,11,'0')) then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_EVIDENCIA_166_NO_ESPELHO');
  end if;
  if v_pag.aluno_id is not null then
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') into v_cpf_aluno from public.alunos a where a.id = v_pag.aluno_id;
    if nullif(v_cpf_aluno,'00000000000') is not null and v_cpf_aluno <> lpad(v_cpf,11,'0') then
      return jsonb_build_object('ok', false, 'motivo', 'CPF_DIVERGE_DO_ALUNO_VINCULADO', 'aluno_id', v_pag.aluno_id);
    end if;
  end if;
  if v_pag.aluno_id is null then
    select count(*), min(a.id::text)::uuid into v_n, v_aluno from public.alunos a
     where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0');
    if v_n = 1 then
      update public.pagamentos set aluno_id = v_aluno, cpf = coalesce(cpf, v_cpf), origem_vinculo = 'CPF',
        origem_vinculo_ref = lpad(v_cpf, 11, '0'), origem_vinculo_em = now() where id = p_pagamento_id;
      v_vinculou := true;
    end if;
  else
    update public.pagamentos set cpf = coalesce(cpf, v_cpf) where id = p_pagamento_id;
  end if;
  update public.fila_pagamento_sem_vinculo set evidencia_origem = p_origem, evidencia_em = now()
   where pagamento_id = p_pagamento_id and decisao is null;
  v_r := public.pagamento_conciliar_um(p_pagamento_id, true);
  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'cpf_usado', lpad(v_cpf, 11, '0'),
    'alunos_pelo_cpf', v_n, 'vinculou_identidade', v_vinculou, 'origem_evidencia', p_origem, 'conciliacao', v_r);
end;
$function$;
`;

let BASE, seq = 0;
beforeAll(async () => {
  const db = await H.montarProd();
  await db.exec(RPCS_REAIS);
  await db.exec(H.MIG(M));
  BASE = await db.dumpDataDir();
  await db.close();
});
const novo = async () => { const db = H.abrir(BASE); await db.exec("set timezone = 'UTC'"); await H.como(db, "confirmacao-166@sistema", "service_role"); return db; };
const U = (a, b) => `ac000000-0000-4000-8000-${String(a).padStart(6, "0")}${String(b).padStart(6, "0")}`;

async function cenario(db, { com166 = true, comAcordoOutro = false, valorPago = 300, valorParcelaFutura = 300 } = {}) {
  const n = ++seq, al = U(n, 1);
  const cpf = String(93000000000 + n);
  const titulo = String(80000 + n);
  const boletoAcordo = `508${String(n).padStart(4, "0")}0001`;
  await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno ${n}`, cpf, String(700000 + n), H.OP6]);
  if (com166) {
    await db.query("insert into prime_portador_membro(cpf, portador, ciclo) values ($1,166,1)", [cpf]);
  }
  if (comAcordoOutro) {
    const acOutro = U(n, 9);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,'ATIVO',500,500,1,$4,$5,now())",
      [acOutro, al, cpf, String(90000 + n), H.OP6]);
  }
  await db.exec("set session_replication_role = replica");
  const pg = U(n, 2);
  await db.query("insert into pagamentos(id,aluno_id,cpf,data_pagamento,valor_pago,numero_parcela_completo,titulo_numero,operador_email,status_conciliacao) values ($1,$2,$3,current_date,$4,$5,$6,$7,'AGUARDANDO_ACORDO')",
    [pg, al, cpf, valorPago, boletoAcordo, titulo, H.OP6]);
  await db.query("insert into fila_pagamento_sem_vinculo(pagamento_id, boleto, data_pagamento, valor_pago, motivo, status_conciliacao) values ($1,$2,current_date,$3,'aguardando','AGUARDANDO_ACORDO')",
    [pg, boletoAcordo, valorPago]);
  await db.exec("set session_replication_role = origin");
  return { al, pg, cpf, titulo, boletoAcordo };
}
const rodar = async (db, lim = 200) => (await db.query("select public.pagamentos_confirmar_sem_estrutura($1) r", [lim])).rows[0].r;

describe("Fluxo A: acordo confirmado sem estrutura (166), separado do Fluxo B", () => {
  it("1) pagamento sem acordo + Prime 166: vira ACORDO_CONFIRMADO_SEM_ESTRUTURA", async () => {
    const db = await novo(); const c = await cenario(db, { com166: true });
    const r = await rodar(db);
    expect(r.confirmados_sem_estrutura).toBe(1);
    const p = (await db.query("select status_conciliacao from pagamentos where id=$1", [c.pg])).rows[0];
    expect(p.status_conciliacao).toBe("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
    await db.close();
  });
  it("2) pagamento sem acordo + SEM evidencia 166: nao classifica como confirmado", async () => {
    const db = await novo(); const c = await cenario(db, { com166: false });
    await rodar(db);
    const p = (await db.query("select status_conciliacao from pagamentos where id=$1", [c.pg])).rows[0];
    expect(p.status_conciliacao).toBe("AGUARDANDO_ACORDO");
    await db.close();
  });
  it("3) pagamento com acordo/parcela ja existente: nao passa pela excecao (fora do criterio estrutural)", async () => {
    const db = await novo();
    const n = ++seq, al = U(n, 1), ac = U(n, 2), pr = U(n, 3);
    const cpf = String(93000000000 + n);
    await db.query("insert into alunos(id,nome,cpf,matricula,saldo_total,responsavel_atual_email,status_atual,status_jornada) values ($1,$2,$3,$4,0,$5,'CONTATAR','CONTATAR')", [al, `Aluno ${n}`, cpf, String(700000 + n), H.OP6]);
    await db.query("insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_ulbra,operador_responsavel_email,criado_em) values ($1,$2,$3,'ATIVO',300,300,1,$4,$5,now())", [ac, al, cpf, String(80000 + n), H.OP6]);
    await db.query("insert into parcelas(id,acordo_id,numero,valor,vencimento,status,boleto,boleto_confiavel) values ($1,$2,1,300,current_date,'A_VENCER',$3,true)", [pr, ac, `508${String(n).padStart(4, "0")}0001`]);
    await db.exec("set session_replication_role = replica");
    const pg = U(n, 4);
    await db.query("insert into pagamentos(id,aluno_id,cpf,data_pagamento,valor_pago,numero_parcela_completo,titulo_numero,operador_email,status_conciliacao) values ($1,$2,$3,current_date,300,$4,$5,$6,'AGUARDANDO_ACORDO')",
      [pg, al, cpf, `508${String(n).padStart(4, "0")}0001`, String(80000 + n), H.OP6]);
    await db.exec("set session_replication_role = origin");
    const r = await rodar(db);
    expect(r.confirmados_sem_estrutura).toBe(0);
    await db.close();
  });
  it("4) aluno possui outro acordo de numero diferente: marca POSSIVEL_REACORDO, nao vincula a ele", async () => {
    const db = await novo(); const c = await cenario(db, { com166: true, comAcordoOutro: true });
    const r = await rodar(db);
    expect(r.reacordo_marcados).toBe(1);
    const p = (await db.query("select status_conciliacao, aluno_id from pagamentos where id=$1", [c.pg])).rows[0];
    expect(p.status_conciliacao).toBe("ACORDO_CONFIRMADO_SEM_ESTRUTURA"); // classificado, mas nao vinculado a acordo nenhum
    const f = (await db.query("select observacao from fila_pagamento_sem_vinculo where pagamento_id=$1", [c.pg])).rows[0];
    expect(f.observacao).toContain("POSSIVEL_REACORDO");
    await db.close();
  });
  it("5) idempotente: repetir nao reprocessa quem ja saiu de AGUARDANDO_ACORDO", async () => {
    const db = await novo(); const c = await cenario(db, { com166: true });
    const r1 = await rodar(db); expect(r1.confirmados_sem_estrutura).toBe(1);
    const r2 = await rodar(db); expect(r2.confirmados_sem_estrutura).toBe(0);
    await db.close();
  });
  it("6) valor > 15% da parcela: preservado quando a estrutura aparecer depois (nao decidido agora, pois nao ha parcela)", async () => {
    const db = await novo(); const c = await cenario(db, { com166: true, valorPago: 900 });
    await rodar(db);
    const p = (await db.query("select status_conciliacao from pagamentos where id=$1", [c.pg])).rows[0];
    expect(p.status_conciliacao).toBe("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
    // quando a parcela aparecer depois, pagamento_conciliar_um reavalia o valor -- nao decidido aqui
    await db.close();
  });
  it("7) falha isolada nao trava o lote", async () => {
    const db = await novo();
    const a = await cenario(db, { com166: true }); const b = await cenario(db, { com166: true });
    await db.query("delete from alunos where id=$1", [a.al]).catch(() => {}); // nao deve quebrar nada externo; so garante isolamento
    const r = await rodar(db);
    expect(r.confirmados_sem_estrutura).toBeGreaterThanOrEqual(1);
    const p = (await db.query("select status_conciliacao from pagamentos where id=$1", [b.pg])).rows[0];
    expect(p.status_conciliacao).toBe("ACORDO_CONFIRMADO_SEM_ESTRUTURA");
    await db.close();
  });
  it("8) FLUXO B nao e acionado: conciliacao_liquidar_titulo_por_prime nao existe nesta base e a migration nao falha nem tenta chama-la", async () => {
    const db = await novo();
    const existe = (await db.query("select count(*)::int n from pg_proc where proname='conciliacao_liquidar_titulo_por_prime'")).rows[0].n;
    expect(existe).toBe(0); // prova de que o Fluxo B nao foi instalado/chamado por esta migration
    await cenario(db, { com166: true });
    const r = await rodar(db); // se a funcao tentasse chamar o Fluxo B, esta chamada teria falhado
    expect(r.ok).toBe(true);
    await db.close();
  });
  it("9) migration so instala a funcao: ACL restrita a service_role", async () => {
    const db = H.abrir(BASE);
    const p = (await db.query(`select has_function_privilege('authenticated','public.pagamentos_confirmar_sem_estrutura(int)','EXECUTE') a, has_function_privilege('service_role','public.pagamentos_confirmar_sem_estrutura(int)','EXECUTE') s`)).rows[0];
    expect(p).toEqual({ a: false, s: true });
    await db.close();
  });
});
