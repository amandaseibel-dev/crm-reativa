-- ROLLBACK de 20260922290000_baixa_viva_unica_por_parcela.sql
--
-- Desfaz SO O CODIGO: tira o gatilho e a funcao novos e devolve as duas RPCs
-- exatamente ao que estavam em producao antes desta frente. Os corpos abaixo
-- sao copia byte a byte de
-- supabase/audits/baixa_viva_unica_por_parcela_producao_20260922.sql
-- (md5(prosrc): baixar_parcela_acordo afcfa38a707aa81d8cc7251a00ebf94a,
--  quitar_acordo_cartao 74598c85bcbc8cbde79aa11a92751e5b).
--
-- NAO E ROLLBACK DE DADO. Nada aqui:
--   * apaga baixa;
--   * devolve/estorna baixa, inclusive as 11 historicas duplicadas;
--   * altera parcela, acordo, aluno ou comissao;
--   * faz backfill.
-- Rodar este arquivo apenas volta a permitir que uma segunda baixa viva seja
-- registrada na mesma parcela -- ou seja, reabre o defeito. So faz sentido se
-- a trava estiver barrando um fluxo legitimo que a auditoria nao previu.
--
-- Depois de rodar, vale conferir se apareceu parcela nova com duas baixas
-- vivas: eram 11 no momento da entrega.

drop trigger if exists trg_baixa_viva_unica_por_parcela on public.baixas_pagamento;
drop function if exists public._baixa_viva_unica_por_parcela();

-- ---------------------------------------------------------------------------
-- 1 de 2. baixar_parcela_acordo volta sem a guarda amigavel
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.baixar_parcela_acordo(p_parcela_id uuid, p_data date DEFAULT CURRENT_DATE, p_valor numeric DEFAULT NULL::numeric, p_honorarios numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_agora   timestamptz := now();
  v_data    date := coalesce(p_data, current_date);
  v_parc    public.parcelas%rowtype;
  v_acordo  public.acordos%rowtype;
  v_aluno   public.alunos%rowtype;
  v_baixa   uuid;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Baixa de pagamento e exclusiva da gestao financeira.'
      using errcode = '42501';
  end if;

  select * into v_parc from public.parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela nao encontrada.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_parc.status, '')) = 'PAGO' then
    raise exception 'Esta parcela ja esta paga.' using errcode = 'P0001';
  end if;

  select * into v_acordo from public.acordos where id = v_parc.acordo_id;
  if not found then
    raise exception 'Acordo da parcela nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo esta cancelado -- nao e possivel registrar baixa.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) = 'QUITADO' then
    raise exception 'Este acordo ja esta quitado -- nao e possivel registrar baixa.' using errcode = 'P0001';
  end if;

  select * into v_aluno from public.alunos where id = v_acordo.aluno_id;

  update public.parcelas
     set status = 'PAGO',
         pago_em = (v_data::timestamp at time zone 'America/Sao_Paulo'),
         confirmado_por_email = v_email,
         atualizado_em = v_agora
   where id = p_parcela_id;

  insert into public.baixas_pagamento (
    aluno_id, aluno_nome, aluno_cpf, parcela_id, acordo_id,
    valor_pago, honorarios_recebidos, data_pagamento, status_baixa,
    responsavel_baixa_email, baixado_por_email,
    recebido_em, atualizado_em, baixado_em
  ) values (
    v_acordo.aluno_id::text, v_aluno.nome, v_aluno.cpf, p_parcela_id, v_acordo.id,
    coalesce(p_valor, v_parc.valor, 0), p_honorarios, v_data, 'REALIZADA',
    coalesce(v_acordo.operador_responsavel_email, v_acordo.criado_por_email),
    v_email,
    v_agora, v_agora, v_agora
  ) returning id into v_baixa;

  return jsonb_build_object(
    'ok', true,
    'parcela_id', p_parcela_id,
    'baixa_id', v_baixa,
    'acordo_status', (select status from public.acordos where id = v_acordo.id)
  );
end;
$function$;


-- ---------------------------------------------------------------------------
-- 2 de 2. quitar_acordo_cartao volta sem a guarda tudo-ou-nada
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quitar_acordo_cartao(p_acordo_id uuid, p_data date DEFAULT CURRENT_DATE, p_comprovante_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_agora   timestamptz := now();
  v_data    date := coalesce(p_data, current_date);
  v_acordo  public.acordos%rowtype;
  v_aluno   public.alunos%rowtype;
  v_qtd     int := 0;
  v_total   numeric := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Quitacao/baixa e exclusiva da gestao financeira.'
      using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo esta cancelado -- nao e possivel quitar.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) = 'QUITADO' then
    raise exception 'Este acordo ja esta quitado.' using errcode = 'P0001';
  end if;

  select * into v_aluno from public.alunos where id = v_acordo.aluno_id;

  insert into public.baixas_pagamento (
    aluno_id, aluno_nome, aluno_cpf, parcela_id, acordo_id,
    valor_pago, honorarios_recebidos, data_pagamento, comprovante_url, status_baixa,
    responsavel_baixa_email, baixado_por_email,
    recebido_em, atualizado_em, baixado_em
  )
  select
    v_acordo.aluno_id::text, v_aluno.nome, v_aluno.cpf, p.id, v_acordo.id,
    coalesce(p.valor, 0), p.honorarios, v_data, nullif(btrim(p_comprovante_url), ''), 'REALIZADA',
    coalesce(v_acordo.operador_responsavel_email, v_acordo.criado_por_email),
    v_email,
    v_agora, v_agora, v_agora
  from public.parcelas p
  where p.acordo_id = p_acordo_id
    and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO');

  update public.parcelas p
     set status = 'PAGO',
         pago_em = (v_data::timestamp at time zone 'America/Sao_Paulo'),
         confirmado_por_email = v_email,
         atualizado_em = v_agora
   where p.acordo_id = p_acordo_id
     and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO');
  get diagnostics v_qtd = row_count;

  if v_qtd = 0 then
    raise exception 'Este acordo nao tem parcelas em aberto para quitar.' using errcode = 'P0001';
  end if;

  select coalesce(sum(valor_pago), 0) into v_total
    from public.baixas_pagamento
   where acordo_id = p_acordo_id and baixado_em = v_agora and baixado_por_email = v_email;

  return jsonb_build_object(
    'ok', true,
    'parcelas_quitadas', v_qtd,
    'valor_total', v_total,
    'acordo_status', (select status from public.acordos where id = p_acordo_id)
  );
end;
$function$;
