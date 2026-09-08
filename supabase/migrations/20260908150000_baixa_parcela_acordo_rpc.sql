-- Baixa de parcela de acordo em uma transacao so, com teto de 60 s.
--
-- Amanda, 08/09/2026: "erro para dar baixa de pagamento de acordo".
--
-- O QUE ACONTECIA: a ficha do aluno (FinanceiroAluno.jsx) dava baixa numa
-- parcela com um PATCH solto em `parcelas` pelo supabase-js. Quando a parcela
-- baixada e a ULTIMA do acordo, os gatilhos fecham o acordo, quitam o aluno e
-- o caso -- e a quitacao do caso dispara `trg_repor_caso_operador`, que
-- repoe a vaga na carteira da operadora varrendo a base inteira. Medido em
-- producao em 08/09 (transacao revertida): 17,2 s. O papel `authenticated`
-- tem statement_timeout de 8 s, entao o PATCH era cancelado, a transacao
-- inteira revertia e a tela mostrava "canceling statement due to statement
-- timeout". Tres tentativas as 08:50, tres timeouts, nada gravado.
--
-- E o mesmo problema que o "Quitar e encerrar" teve em 04/08 (migration
-- 20260804170000): a solucao la foi mover a operacao para uma RPC SECURITY
-- DEFINER com `statement_timeout = 60s`. Aqui e feita a mesma coisa para os
-- dois caminhos da ficha que baixam parcela: a baixa de UMA parcela e a
-- quitacao do acordo inteiro pelo cartao.
--
-- Ganho colateral: a parcela e o registro em `baixas_pagamento` passam a ser
-- gravados na mesma transacao. Antes eram dois awaits separados, e a baixa
-- podia ficar registrada sem parcela paga (ou o contrario).
--
-- Quem pode: a mesma regra de sempre, `crm_usuario_pode_quitar_baixar()`
-- (Amanda gestora, Fernanda/supervisao, Amanda ADM). O gatilho de reposicao
-- NAO foi tocado -- ele e o gatilho sensivel da redistribuicao.

create or replace function public.baixar_parcela_acordo(
  p_parcela_id uuid,
  p_data date default current_date,
  p_valor numeric default null,
  p_honorarios numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
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

  -- pago_em na meia-noite de Sao Paulo, igual ao que a tela gravava
  -- (new Date(data + "T00:00:00").toISOString()). Meia-noite UTC cairia no
  -- dia anterior no horario do Brasil.
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
$$;

revoke all on function public.baixar_parcela_acordo(uuid, date, numeric, numeric) from public, anon;
grant execute on function public.baixar_parcela_acordo(uuid, date, numeric, numeric) to authenticated, service_role;

comment on function public.baixar_parcela_acordo(uuid, date, numeric, numeric) is
  'Baixa uma parcela de acordo e registra em baixas_pagamento na mesma transacao, com teto de 60s (a quitacao em cascata dispara a reposicao de carteira, ~17s). Substitui o PATCH solto da ficha. So gestao financeira.';


create or replace function public.quitar_acordo_cartao(
  p_acordo_id uuid,
  p_data date default current_date,
  p_comprovante_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
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

  -- Uma linha de baixa por parcela, como a tela fazia, ANTES de virar as
  -- parcelas (depois do update elas ja estao PAGO e sairiam do filtro).
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
$$;

revoke all on function public.quitar_acordo_cartao(uuid, date, text) from public, anon;
grant execute on function public.quitar_acordo_cartao(uuid, date, text) to authenticated, service_role;

comment on function public.quitar_acordo_cartao(uuid, date, text) is
  'Quita todas as parcelas em aberto de um acordo (pagamento no cartao) e registra uma baixa por parcela, na mesma transacao e com teto de 60s. Substitui o PATCH solto da ficha. So gestao financeira.';
