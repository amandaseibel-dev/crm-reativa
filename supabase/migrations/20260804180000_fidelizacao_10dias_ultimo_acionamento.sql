-- =====================================================================
-- FIDELIZAÇÃO 10 DIAS ancorada no ÚLTIMO ACIONAMENTO VÁLIDO
-- Regra oficial: exclusividade do operador por 10 dias corridos a partir de
-- cada acionamento humano válido; cada novo acionamento reinicia o prazo.
-- Ao expirar: caso vira LIVRE (sem atribuição automática), preservando o
-- responsável anterior no histórico e a DATA DO ÚLTIMO ACIONAMENTO.
-- Motivo de liberação: FIDELIZACAO_EXPIRADA.
--
-- NÃO usa internal.set_resp_aluno (que zera data_ultimo_acionamento — violaria
-- 'preservar a data do último acionamento'). Zerar operador_email NÃO dispara
-- reposição (trg_repor_caso_operador faz early-return com operador nulo).
-- Assumir NÃO inicia fidelização (só acionamento válido inicia).
-- Prazo pós-assunção: reusa o bloqueio operacional existente (hold de 1 dia).
-- =====================================================================

drop function if exists public.casos_elegiveis_liberacao_fidelizacao();
drop function if exists public.liberar_casos_fidelizacao_vencida();

-- Elegíveis à liberação (regra nova: último acionamento + 10 < hoje, ou nunca
-- acionado). Exclui protegidos/encerrados. Hold operacional: não libera quem
-- assumiu nas últimas 24h (dá janela para o 1º acionamento).
create or replace function public.casos_elegiveis_liberacao_fidelizacao()
returns table(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text,
              data_ultimo_acionamento date, fidelizado_ate date)
language sql stable security definer set search_path to 'public'
as $$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    -- hold operacional: não liberar quem assumiu nas últimas 24h
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$$;
revoke all on function public.casos_elegiveis_liberacao_fidelizacao() from public, anon;

-- Liberação de UM caso (preserva data_ultimo_acionamento; loga histórico + motivo).
create or replace function public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text default 'FIDELIZACAO_EXPIRADA', p_autor text default 'sistema_fidelizacao')
returns boolean language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_c record;
begin
  select * into v_c from public.casos where id = p_caso_id for update;  -- trava a linha
  if not found or v_c.operador_email is null then return false; end if;
  -- zera titularidade no caso (NAO toca data_ultimo_acionamento / status / retorno)
  update public.casos set operador_email=null, operador_nome=null, operador=null,
    caso_atualizado_por=p_autor, caso_atualizado_em=now()
  where id = p_caso_id;
  -- espelha no aluno (preserva data_ultimo_acionamento)
  if v_c.aluno_id is not null then
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null
    where id = v_c.aluno_id;
  end if;
  insert into public.historico_operadores_alunos
    (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  values (v_c.chave_unificacao, v_c.nome, v_c.cpf, p_motivo, v_c.operador_nome, v_c.operador_email,
    'Fidelizacao expirada (ultimo acionamento '||coalesce(v_c.data_ultimo_acionamento::text,'nunca')||' + 10d). Caso LIVRE, sem atribuicao automatica. Responsavel anterior preservado.', now());
  return true;
end;
$$;
revoke all on function public.liberar_fidelizacao_caso(uuid,text,text) from public, anon;

-- Liberação em lote dos vencidos (gestão/cron). Preserva acionamento; sem redistribuição.
create or replace function public.liberar_casos_fidelizacao_vencida(p_limite integer default null)
returns integer language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_rec record; v_total int := 0;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;
  for v_rec in select * from public.casos_elegiveis_liberacao_fidelizacao() limit coalesce(p_limite, 100000)
  loop
    if public.liberar_fidelizacao_caso(v_rec.caso_id, 'FIDELIZACAO_EXPIRADA', 'fidelizacao_expirada_lote') then
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$$;
revoke all on function public.liberar_casos_fidelizacao_vencida(integer) from public, anon;
grant execute on function public.liberar_casos_fidelizacao_vencida(integer) to authenticated;

-- Cron diário de liberação por fidelização vencida (08:20 UTC = 05:20 BRT).
select cron.unschedule('fidelizacao_liberar_vencidos')
where exists (select 1 from cron.job where jobname='fidelizacao_liberar_vencidos');
select cron.schedule('fidelizacao_liberar_vencidos', '20 8 * * *',
  $cron$ select public.liberar_casos_fidelizacao_vencida(); $cron$);

-- Assumir caso livre — trava atômica (FOR UPDATE) + registro assumido_por/em/motivo.
create or replace function public.assumir_caso_livre(p_caso_id uuid)
returns table(sucesso boolean, mensagem text, caso_liberado uuid)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  v_upper := upper(v_nome);

  -- TRAVA ATOMICA: bloqueia a linha do caso ate o fim da transacao (impede assuncao dupla)
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;

  if coalesce(v_new.operador_email,'') <> '' then
    return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;

  v_new_saldo := v_new._saldo;
  v_count := (select count(*) from public.casos where operador_email = v_email);

  if v_count >= 500 then
    select c.id into v_rel
    from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;

  -- assume: NAO inicia fidelizacao (data_ultimo_acionamento inalterada). O prazo de
  -- 10 dias so comeca com acionamento valido. caso_atualizado_em = hold operacional.
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido caso livre. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;

  if (select count(*) from public.casos where operador_email = v_email) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;

  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;
revoke all on function public.assumir_caso_livre(uuid) from public, anon;
grant execute on function public.assumir_caso_livre(uuid) to authenticated;
