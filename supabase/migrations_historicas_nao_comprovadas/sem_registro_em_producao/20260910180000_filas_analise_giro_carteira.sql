-- FILAS DE ANALISE E APOIO AO GIRO DE CARTEIRA (10/09/2026)
--
-- Reune o que foi aplicado em producao durante o giro, fora as duas funcoes que
-- ja tem migration propria (o giro em si e o nivelamento automatico da gestao):
--
--   fila_acordos_sem_responsavel     -- acordo ATIVO que ninguem acompanha:
--                                       sem ficha no CRM ou ficha sem operador
--   atribuir_acordo_sem_responsavel  -- da dono a um desses casos; recusa se o
--                                       caso ja tiver responsavel (o operador
--                                       continua dono do caso dele)
--   fila_fora_da_cobranca            -- o que a instituicao decidiu NAO cobrar,
--                                       separado por motivo: CANCELAMENTO,
--                                       NAO_ACIONAR e JURIDICO
--   atualizar_semestre_divida        -- alimenta alunos.semestre_divida, que da
--                                       a prioridade 2026/2 -> 2026/1 na fila
--   girar_mensalidades_com_acordo    -- gira a mensalidade solta que convive com
--                                       acordo ativo, sem tocar no dono do
--                                       acordo (ainda NAO executado em prod)
--
-- Todas foram aplicadas direto em producao no dia; este arquivo versiona o
-- estado final delas.


-- Colunas de apoio -------------------------------------------------------

-- Titularidade SEPARADA da mensalidade: o acordo fica com quem fechou, a
-- mensalidade solta pode girar. Nao reaproveitamos casos.operador_mensalidade /
-- operador_acordo, que ja existiam: sao residuo de carga externa (nome em caixa
-- alta, valores como 'RECEPTIVO'), preenchidos em 1.692 de 17.911 casos e nunca
-- atualizados.
alter table public.casos
  add column if not exists operador_mensalidade_email text,
  add column if not exists operador_mensalidade_nome  text,
  add column if not exists mensalidade_girada_em      timestamptz;
create index if not exists idx_casos_operador_mensalidade
  on public.casos (operador_mensalidade_email) where operador_mensalidade_email is not null;

-- Semestre da divida na fila operacional. A fila e ordenada no navegador a
-- partir da tabela `alunos`, e ali nao havia como saber de que semestre e a
-- divida. alunos.semestre ja existia, mas esta vazia nos 6.758 registros.
alter table public.alunos
  add column if not exists semestre_divida text,
  add column if not exists semestre_divida_em timestamptz;
create index if not exists idx_alunos_semestre_divida
  on public.alunos (semestre_divida) where semestre_divida is not null;

CREATE OR REPLACE FUNCTION public.atribuir_acordo_sem_responsavel(p_caso_id uuid, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_nome text; v_caso record;
begin
  if not (public.calibragem_e_gestao() or public.usuario_e_gestao()) then
    raise exception 'Sem permissão para atribuir responsável.';
  end if;

  select nome into v_nome from public.usuarios where email = p_email and ativo;
  if v_nome is null then
    raise exception 'Operador % não encontrado ou inativo.', p_email;
  end if;

  select * into v_caso from public.casos where id = p_caso_id;
  if not found then raise exception 'Caso não encontrado.'; end if;
  if v_caso.operador_email is not null then
    raise exception 'Este caso já tem responsável (%).', v_caso.operador_nome;
  end if;

  perform set_config('calibragem.bypass_teto', 'on', true);

  update public.casos
     set operador_email = p_email, operador_nome = v_nome, operador = upper(v_nome)
   where id = p_caso_id;

  insert into public.historico_operadores_alunos(aluno_id, chave_unificacao, nome_aluno, cpf_referencia,
    acao, operador_nome, operador_email, observacao, criado_em)
  values (v_caso.aluno_id, v_caso.chave_unificacao, coalesce(v_caso.nome, v_caso.nome_aluno), v_caso.cpf,
    'ACORDO_SEM_RESPONSAVEL_ATRIBUIDO', v_nome, p_email,
    'Acordo ativo sem responsável: dono definido pela fila de Confirmação de Pagamentos.', now());

  return jsonb_build_object('caso_id', p_caso_id, 'operador_email', p_email, 'operador_nome', v_nome);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.atualizar_semestre_divida()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_atualizados int;
begin
  with calc as (
    select a.id,
           case when s.venc_max is null then null
                when extract(month from s.venc_max) < 7
                  then to_char(s.venc_max, 'YYYY') || '/1'
                else to_char(s.venc_max, 'YYYY') || '/2' end sem
      from public.alunos a
      join public.calibragem_saldo_aluno s on s.aluno_id = a.id
     where coalesce(s.saldo_total, 0) > 0
  )
  update public.alunos a
     set semestre_divida = calc.sem, semestre_divida_em = now()
    from calc
   where a.id = calc.id
     and a.semestre_divida is distinct from calc.sem;
  get diagnostics v_atualizados = row_count;

  -- Quem zerou a divida perde o rotulo: senao a fila continuaria priorizando
  -- um aluno que nao deve mais nada.
  update public.alunos a
     set semestre_divida = null, semestre_divida_em = now()
   where a.semestre_divida is not null
     and not exists (select 1 from public.calibragem_saldo_aluno s
                      where s.aluno_id = a.id and coalesce(s.saldo_total,0) > 0);

  return jsonb_build_object('atualizados', v_atualizados, 'em', now());
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fila_acordos_sem_responsavel()
 RETURNS TABLE(acordo_id uuid, situacao text, cpf text, aluno text, caso_id uuid, aluno_id uuid, valor_total numeric, saldo_aberto numeric, parcelas_abertas integer, parcelas_vencidas integer, dias_atraso integer, quem_fechou_email text, quem_fechou_nome text, criado_em timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ac as (
    select a.id, a.cpf, a.valor_total, a.operador_responsavel_email, a.criado_em,
           count(*) filter (where pp.ab)::int abertas,
           count(*) filter (where pp.ab and pp.vencimento < current_date)::int vencidas,
           max(current_date - pp.vencimento) filter (where pp.ab and pp.vencimento < current_date)::int dias,
           round(sum(pp.valor) filter (where pp.ab), 2) saldo
      from public.acordos a
      join lateral (
        select pp.*, upper(coalesce(pp.status,'')) not in
               ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') ab
          from public.parcelas pp where pp.acordo_id = a.id) pp on true
     where a.status = 'ATIVO'
     group by a.id, a.cpf, a.valor_total, a.operador_responsavel_email, a.criado_em
  )
  select ac.id,
         case when c.id is null then 'SEM_FICHA' else 'SEM_DONO' end,
         ac.cpf,
         coalesce(c.nome, c.nome_aluno),
         c.id, c.aluno_id,
         ac.valor_total, ac.saldo, ac.abertas, ac.vencidas, ac.dias,
         ac.operador_responsavel_email, u.nome, ac.criado_em
    from ac
    left join public.casos c
      on lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'), 11, '0') = ac.cpf
    left join public.usuarios u on u.email = ac.operador_responsavel_email
   where c.id is null or c.operador_email is null
   order by ac.saldo desc nulls last;
$function$
;

CREATE OR REPLACE FUNCTION public.fila_fora_da_cobranca(p_motivo text DEFAULT NULL::text)
 RETURNS TABLE(caso_id uuid, aluno_id uuid, motivo text, aluno text, cpf text, matricula text, valor_total numeric, mensalidade numeric, acordo numeric, status_acionamento text, status_financeiro text, nao_acionar boolean, operador_nome text, data_ultimo_acionamento date, venc_max date, encerrado boolean, tem_acordo_ativo boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.aluno_id,
    case when public.normalizar_status_acionamento(c.status_acionamento) in ('CANCELAMENTO COBRANCA','CANCELADO')
           or public.normalizar_status_acionamento(c.status_financeiro) in ('CANCELAMENTO COBRANCA','CANCELADO')
         then 'CANCELAMENTO'
         when public.normalizar_status_acionamento(c.status_acionamento) = 'JURIDICO'
           or public.normalizar_status_acionamento(c.status_financeiro) = 'JURIDICO'
         then 'JURIDICO'
         else 'NAO_ACIONAR' end,
    coalesce(c.nome, c.nome_aluno),
    c.cpf, c.matricula,
    round(coalesce(s.saldo_total, 0), 2),
    round(coalesce(s.saldo_mensalidade, 0), 2),
    round(coalesce(s.saldo_acordo, 0), 2),
    public.normalizar_status_acionamento(c.status_acionamento),
    public.normalizar_status_acionamento(c.status_financeiro),
    coalesce(c.nao_acionar, false),
    coalesce(c.operador_nome, '(sem dono)'),
    c.data_ultimo_acionamento,
    s.venc_max,
    public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
      c.status_financeiro, c.status_jornada),
    exists (select 1 from public.acordos a
             where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'), 11, '0')
               and a.status = 'ATIVO')
  from public.casos c
  left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
  where (coalesce(c.nao_acionar, false)
      or public.normalizar_status_acionamento(c.status_acionamento) in ('CANCELAMENTO COBRANCA','CANCELADO','JURIDICO')
      or public.normalizar_status_acionamento(c.status_financeiro) in ('CANCELAMENTO COBRANCA','CANCELADO','JURIDICO'))
    and (p_motivo is null or p_motivo = (
      case when public.normalizar_status_acionamento(c.status_acionamento) in ('CANCELAMENTO COBRANCA','CANCELADO')
             or public.normalizar_status_acionamento(c.status_financeiro) in ('CANCELAMENTO COBRANCA','CANCELADO')
           then 'CANCELAMENTO'
           when public.normalizar_status_acionamento(c.status_acionamento) = 'JURIDICO'
             or public.normalizar_status_acionamento(c.status_financeiro) = 'JURIDICO'
           then 'JURIDICO'
           else 'NAO_ACIONAR' end))
  order by coalesce(s.saldo_total, 0) desc;
$function$
;

CREATE OR REPLACE FUNCTION public.girar_mensalidades_com_acordo(p_aplicar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_n_ops int; v_res jsonb; v_movidos int := 0;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para girar as mensalidades.';
  end if;

  create temp table _ops on commit drop as
  select row_number() over (order by email) - 1 slot, email, nome
    from public.usuarios where ativo and perfil = 'operador';
  select count(*) into v_n_ops from _ops;
  if v_n_ops = 0 then raise exception 'Nenhum operador ativo.'; end if;

  create temp table _mens on commit drop as
  select c.id caso_id, c.aluno_id, c.chave_unificacao,
         coalesce(c.nome, c.nome_aluno) nome, c.cpf,
         c.operador_email dono_acordo_email, c.operador_nome dono_acordo_nome,
         c.operador_mensalidade_email antes_email,
         round(s.saldo_mensalidade, 2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where coalesce(s.saldo_acordo, 0) > 0
     and coalesce(s.saldo_mensalidade, 0) > 0
     and c.operador_email is not null
     and not coalesce(c.nao_acionar, false)
     and public.normalizar_status_acionamento(c.status_acionamento) is distinct from 'CANCELAMENTO COBRANCA'
     and public.normalizar_status_acionamento(c.status_acionamento) is distinct from 'CANCELADO'
     and public.normalizar_status_acionamento(c.status_acionamento) is distinct from 'JURIDICO'
     and public.normalizar_status_acionamento(c.status_financeiro) is distinct from 'CANCELAMENTO COBRANCA'
     and public.normalizar_status_acionamento(c.status_financeiro) is distinct from 'CANCELADO'
     and public.normalizar_status_acionamento(c.status_financeiro) is distinct from 'JURIDICO'
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
           c.status_acionamento, c.status_financeiro, c.status_jornada);

  alter table _mens add column para_email text, add column para_nome text;

  with fila as (
    select caso_id, row_number() over (order by valor desc, caso_id) - 1 r from _mens
  )
  update _mens m
     set para_email = o.email, para_nome = o.nome
    from fila f
    join _ops o on o.slot = case when (f.r / v_n_ops) % 2 = 0
                                 then f.r % v_n_ops
                                 else v_n_ops - 1 - (f.r % v_n_ops) end
   where f.caso_id = m.caso_id;

  if p_aplicar then
    update public.casos c
       set operador_mensalidade_email = m.para_email,
           operador_mensalidade_nome  = m.para_nome,
           mensalidade_girada_em      = now()
      from _mens m where c.id = m.caso_id;
    get diagnostics v_movidos = row_count;

    insert into public.historico_operadores_alunos(aluno_id, chave_unificacao, nome_aluno, cpf_referencia,
      acao, operador_nome, operador_email, operador_anterior_email, observacao, criado_em)
    select m.aluno_id, m.chave_unificacao, m.nome, m.cpf, 'GIRO_MENSALIDADE_COM_ACORDO',
      m.para_nome, m.para_email, m.antes_email,
      'Mensalidade solta girada para cobrança; o acordo e o aluno continuam com ' || coalesce(m.dono_acordo_nome,'—') || '.',
      now()
    from _mens m where m.para_email is distinct from m.antes_email;
  end if;

  select jsonb_build_object(
    'aplicado', p_aplicar,
    'alunos', (select count(*) from _mens),
    'valor', (select round(sum(valor),2) from _mens),
    'atualizados', v_movidos,
    'ficaram_com_o_dono_do_acordo', (select count(*) from _mens where para_email = dono_acordo_email),
    'destino', (select coalesce(jsonb_agg(jsonb_build_object('operador', para_nome, 'alunos', q, 'valor', v) order by v desc), '[]')
                  from (select para_nome, count(*) q, round(sum(valor),2) v from _mens group by para_nome) t)
  ) into v_res;
  return v_res;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.nivelamento_automatico_gestao(p_dias integer DEFAULT 10, p_aplicar boolean DEFAULT true, p_origens text[] DEFAULT ARRAY['amanda.seibel@aelbra.com.br'::text])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res jsonb; v_movidos int := 0; v_caso record; v_dest record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para nivelar a base da gestão.';
  end if;
  p_dias := greatest(coalesce(p_dias, 10), 0);

  create temp table _eleg on commit drop as
  select c.id caso_id, c.aluno_id, c.chave_unificacao, coalesce(c.nome, c.nome_aluno) nome,
         c.cpf, c.operador_email de_email,
         exists (select 1 from public.acordos a where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'),11,'0') and a.status = 'ATIVO') tem_acordo,
         round(coalesce(s.saldo_total,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where c.operador_email = any(p_origens)
     and coalesce(s.saldo_total,0) > 0
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
     and not exists (select 1 from public.links_pagamento l where l.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and l.status in ('AGUARDANDO_BAIXA','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO'))
     and not exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and b.status_baixa = 'AGUARDANDO_BAIXA')
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento sc where sc.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and sc.status = 'AGUARDANDO_CONFIRMACAO')
     and (
       exists (select 1 from public.acordos a join public.parcelas pp on pp.acordo_id = a.id
                where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0') and a.status = 'ATIVO'
                  and upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
                  and pp.vencimento < current_date - p_dias)
       or exists (select 1 from public.acordos_titulos t
                   where t.aluno_id = c.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
                     and lower(coalesce(t.status,'')) = 'em_aberto' and t.acordo_id is null
                     and t.vencimento < current_date - p_dias)
     );

  if not exists (select 1 from _eleg) then
    return jsonb_build_object('dias', p_dias, 'elegiveis', 0, 'movidos', 0,
                              'mensagem', 'Nada vencido além de ' || p_dias || ' dias na base da gestão.');
  end if;

  create temp table _op on commit drop as
  select u.email, u.nome,
         (select count(*) from public.acordos a
            join public.casos c2 on lpad(regexp_replace(coalesce(c2.cpf_limpo,''),'\D','','g'),11,'0') = a.cpf
           where a.status = 'ATIVO' and c2.operador_email = u.email)::int carga_acordo,
         (select count(*) from public.casos c3
            join public.calibragem_saldo_aluno s3 on s3.aluno_id = c3.aluno_id
           where c3.operador_email = u.email and coalesce(s3.saldo_total,0) > 0
             and not public.caso_encerrado_operacional(c3.cpf_limpo, c3.status_atual, c3.status_acionamento, c3.status_financeiro, c3.status_jornada)
             and not public.caso_protegido_redistribuicao(c3.cpf_limpo, c3.status_acionamento, c3.nao_acionar,
                   c3.status_financeiro, c3.valor_pago, c3.quitado_em, c3.valor_quitado))::int carga_caso
    from public.usuarios u
   where u.ativo and u.perfil = 'operador' and not (u.email = any(p_origens));
  if not exists (select 1 from _op) then
    raise exception 'Nenhum operador ativo para receber o nivelamento.';
  end if;

  alter table _eleg add column para_email text, add column para_nome text;

  create temp table _fila on commit drop as
    select caso_id, tem_acordo from _eleg order by tem_acordo desc, valor desc, caso_id;

  for v_caso in select * from _fila loop
    if v_caso.tem_acordo then
      select * into v_dest from _op order by carga_acordo asc, carga_caso asc, email limit 1;
      update _op set carga_acordo = carga_acordo + 1, carga_caso = carga_caso + 1 where email = v_dest.email;
    else
      select * into v_dest from _op order by carga_caso asc, carga_acordo asc, email limit 1;
      update _op set carga_caso = carga_caso + 1 where email = v_dest.email;
    end if;
    update _eleg set para_email = v_dest.email, para_nome = v_dest.nome where caso_id = v_caso.caso_id;
  end loop;

  if p_aplicar then
    perform set_config('calibragem.bypass_teto', 'on', true);
    update public.casos c
       set operador_email = e.para_email, operador_nome = e.para_nome, operador = upper(coalesce(e.para_nome,''))
      from _eleg e where c.id = e.caso_id and e.para_email is not null;
    get diagnostics v_movidos = row_count;

    insert into public.historico_operadores_alunos(aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao,
      operador_nome, operador_email, operador_anterior_email, observacao, criado_em)
    select e.aluno_id, e.chave_unificacao, e.nome, e.cpf, 'NIVELAMENTO_AUTOMATICO_GESTAO',
      e.para_nome, e.para_email, e.de_email,
      'Débito vencido há mais de ' || p_dias || ' dias na base da gestão: distribuído automaticamente para quem tinha menos.',
      now()
    from _eleg e where e.para_email is not null;
  end if;

  select jsonb_build_object(
    'dias', p_dias, 'aplicado', p_aplicar,
    'elegiveis', (select count(*) from _eleg),
    'movidos', v_movidos,
    'com_acordo', (select count(*) from _eleg where tem_acordo),
    'so_mensalidade', (select count(*) from _eleg where not tem_acordo),
    'valor', (select round(sum(valor),2) from _eleg),
    'destino', (select coalesce(jsonb_agg(jsonb_build_object('operador', para_nome, 'casos', q, 'valor', v) order by q desc),'[]')
                  from (select para_nome, count(*) q, round(sum(valor),2) v from _eleg where para_email is not null group by para_nome) t),
    'carga_depois', (select coalesce(jsonb_agg(jsonb_build_object('operador', nome, 'acordos', carga_acordo, 'casos', carga_caso) order by carga_acordo desc),'[]') from _op)
  ) into v_res;
  return v_res;
end;
$function$
;


-- Permissoes -------------------------------------------------------------
revoke all on function public.fila_acordos_sem_responsavel() from public, anon;
revoke all on function public.atribuir_acordo_sem_responsavel(uuid, text) from public, anon;
revoke all on function public.fila_fora_da_cobranca(text) from public, anon;
revoke all on function public.atualizar_semestre_divida() from public, anon;
revoke all on function public.girar_mensalidades_com_acordo(boolean) from public, anon, authenticated;
grant execute on function public.fila_acordos_sem_responsavel() to authenticated;
grant execute on function public.atribuir_acordo_sem_responsavel(uuid, text) to authenticated;
grant execute on function public.fila_fora_da_cobranca(text) to authenticated;
grant execute on function public.atualizar_semestre_divida() to authenticated;
grant execute on function public.girar_mensalidades_com_acordo(boolean) to authenticated;

-- O semestre da divida muda quando o aluno paga ou ganha titulo novo: sem o
-- recalculo a fila priorizaria pelo estado de ontem.
select cron.schedule('semestre_divida_horario', '7 * * * *',
  $cron$select public.atualizar_semestre_divida()$cron$);
