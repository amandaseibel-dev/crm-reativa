declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
  -- v_teto: teto oficial da gestao. v_pool: qual das tres carteiras de livre
  -- assuncao cedeu o caso (nulo quando veio da fila livre ou de um caso de giro).
  v_teto int; v_pool text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  if not internal.operador_pode_receber_caso(v_email) then return query select false,'Sua carteira esta fechada para casos novos. Fale com a gestao.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    -- Artigo 2: Carteira Geral, carteira da gestao e antiga carteira da Olga
    -- sao de LIVRE ASSUNCAO -- qualquer operador assume na hora, sem esperar os
    -- 10 dias. O criterio e estrutural: o dono atual nao e operador ativo.
    select case
             when lower(v_new.operador_email) = internal.carteira_geral_email()
               then 'Carteira Geral'
             when not exists (select 1 from public.usuarios u
                               where lower(u.email) = lower(v_new.operador_email)
                                 and u.ativo and u.perfil = 'operador')
               then 'carteira de ' || coalesce((select u.nome from public.usuarios u
                                                 where lower(u.email) = lower(v_new.operador_email)
                                                 limit 1), v_new.operador_email)
           end into v_pool;

    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then
      return query select false,'Este caso está fidelizado pelo giro de carteira até 26/10/2026.',null::uuid; return;
    end if;
    if v_pool is null and v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;
    -- Caso de giro com a fidelizacao ja vencida: segue adiante e troca o dono.
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  -- Teto oficial da gestao, nao numero literal.
  v_teto := public.calibragem_teto_operador(v_email);
  -- MESMA base que `trg_impor_teto_operador` cobra: nao protegido e nao
  -- encerrado. A base antiga (carteira inteira menos confirmacao financeira)
  -- dava ~1.000 por operador e por isso recusava toda assuncao.
  v_count := (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada));
  if v_count >= v_teto then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia ('||v_teto||' casos) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido de '||coalesce(v_pool,'fila livre')||'. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)) > v_teto then
    raise exception 'ROLLBACK: operador ficaria com mais de % casos (teto vigente).', v_teto;
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
