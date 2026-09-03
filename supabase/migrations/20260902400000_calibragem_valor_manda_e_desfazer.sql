-- Calibragem: o "valor igual" volta a acontecer, e a gestao ganha o desfazer.
--
-- Amanda, 02/09: "quero ter mais autonomia nessa calibragem" + regra de
-- desempate confirmada: quando 500-por-cabeca, valor-igual e distribuicao-por-ano
-- brigam, VALOR IGUAL MANDA.
--
-- O QUE ESTAVA ACONTECENDO. A simulacao de 01/09 (todos os anos, alvo 500)
-- produziu 1.029 movimentacoes e um equilibrio de valor de 80,5 -- contra os
-- ~99 de agosto. Olhando as 1.029 uma a uma: TODAS eram da fase 1 (soltar para
-- o pool). A fase 2 nao puxou nada e a fase 3 -- a unica que equilibra valor --
-- nao trocou UM caso sequer. O resultado deixaria Olga com R$ 2,38 mi e
-- Mauricio com R$ 1,39 mi. Por isso a Amanda simulou e nao aplicou.
--
-- POR QUE A FASE 3 FICOU MUDA. A fase 1 escolhe o que soltar por
-- `order by venc_min asc, valor asc` -- divida mais antiga, mais barata --
-- e solta exatamente os casos PARADOS (+10d). A fase 3 so pode trocar caso
-- parado ou vindo do pool, para nao ferir os 10 dias de fidelizacao do dono
-- atual. Ou seja: a fase 1 consome justamente o estoque que a fase 3 precisaria.
-- Quando todo mundo esta acima do alvo (era o caso: 501 a 719 casos cada), a
-- fase 1 leva todos os parados, a fase 2 nao tem ninguem abaixo para completar,
-- e a fase 3 acorda sem um unico candidato. O equilibrio de valor virou letra
-- morta -- silenciosamente, porque a tela mostra o indice sem dizer que ninguem
-- trocou nada.
--
-- QUATRO MUDANCAS:
--
--   1. FASE 1 PASSA A ESCOLHER PELO VALOR. Em vez de soltar o mais antigo e
--      mais barato, solta o caso que aproxima o saldo do operador da media da
--      equipe. Quem esta com saldo alto solta os caros; quem esta com saldo
--      baixo solta os baratos. O equilibrio passa a ser construido na fase que
--      de fato move os casos, em vez de depender de uma fase 3 sem estoque.
--
--   2. FASE 2 IDEM, com a divida mais recente como desempate. A regra "puxa do
--      pool, recente primeiro" continua -- deixa de ser a unica ordenacao e
--      passa a decidir entre casos de valor equivalente.
--
--   3. FASE 3 NAO ABORTA MAIS NO PRIMEIRO PAR RUIM. Ela pegava o caso MAIS CARO
--      do operador mais rico; se a troca passasse do ponto (`v_delta >= v_gap`)
--      dava `exit` e MATAVA a fase inteira. Agora procura, entre os casos do
--      mais rico, o que fecha ate metade da distancia -- e so encerra quando
--      nao existe nenhum par util.
--
--   4. O EXECUTOR PASSA A CONTAR CASOS DISTINTOS. `v_total` vinha de
--      `jsonb_array_length(movimentacoes)` e `v_feitos` de
--      `count(distinct caso_id)` na auditoria. A lista pode trazer o mesmo caso
--      duas vezes (troca da fase 3, ou aluno com caso duplicado) e a auditoria
--      grava uma vez so. Na aplicacao de 20/08 foram 1.886 linhas planejadas
--      para 1.883 casos distintos: `restantes` travou em 3 para sempre, o laco
--      do front rodou 500 lotes sem mover nada e terminou em
--      "Muitos lotes -- interrompido por seguranca" -- com TUDO ja aplicado.
--      A simulacao ficou EXECUTANDO ate hoje. Agora os dois lados contam caso
--      distinto, e essa simulacao e fechada no fim deste arquivo.
--
-- E O DESFAZER (novo): `calibragem_desfazer_nivelamento_lote` devolve cada caso
-- ao dono anterior lendo a propria auditoria, em lotes curtos como o executor.
-- So devolve o caso que AINDA esta onde o nivelamento o deixou -- se depois
-- disso alguem acionou, negociou ou remanejou, o caso e pulado e registrado
-- como pulado. Reverter tambem e auditado (REVERSAO_NIVELAMENTO); a auditoria
-- continua append-only.
--
-- NAO MUDA: quem esta protegido (negociacao, acordo ativo, link, termo,
-- confirmacao de pagamento) nunca e movido; o piso de 10 dias da fidelizacao;
-- o gate `calibragem_e_gestao()`; o bypass do teto por sessao (sem ALTER TABLE,
-- que travava a tabela de casos inteira).

-- ------------------------------------------------------------------
-- 0. Os dois status novos do ciclo de reversao.
-- ------------------------------------------------------------------
alter table public.calibragem_simulacoes
  drop constraint if exists calibragem_simulacoes_status_check;
alter table public.calibragem_simulacoes
  add constraint calibragem_simulacoes_status_check
  check (status = any (array['RASCUNHO','APROVADA','EXECUTANDO','EXECUTADA',
                             'DESCARTADA','DESFAZENDO','REVERTIDA']));

-- ------------------------------------------------------------------
-- 1. Simulacao: valor manda.
-- ------------------------------------------------------------------
create or replace function public.calibragem_simular_nivelamento_impl(p_criterio jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ops text[];
  v_ano  int := nullif(p_criterio->>'ano','')::int;
  v_alvo int := coalesce(nullif(p_criterio->>'alvo','')::int, 500);
  v_dias int := coalesce(nullif(p_criterio->>'dias_sem_acionamento','')::int, 11);
  v_alvo_ef int; v_pool_total int; v_n_ops int; v_total_disp int;
  v_sim_id uuid; v_resultado jsonb;
  v_op record; v_c record; v_movs int := 0;
  v_ia_qtd numeric; v_id_qtd numeric; v_ia_sal numeric; v_id_sal numeric;
  v_rich text; v_poor text; v_gap numeric; v_delta numeric; v_iter int := 0;
  v_ch record; v_cl record;
  v_saldo_alvo numeric; v_saldo_atual numeric; v_ideal numeric;
  v_qtd_atual numeric; v_faltam int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular a Calibragem.';
  end if;
  -- Piso da fidelizacao: parado = mais de 10 dias sem acionamento.
  v_dias := greatest(v_dias, 10);
  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  create temp table _base on commit drop as
    select c.id caso_id,
           c.operador_email de_email, c.operador_nome de_nome,
           c.operador_email dest_email,
           coalesce(c.cpf_limpo,c.cpf) cpf, coalesce(c.nome,c.nome_aluno) nome,
           round(coalesce(s.saldo_mensalidade,0),2) valor,
           s.venc_min, s.venc_max,
           (c.data_ultimo_acionamento is null
             or c.data_ultimo_acionamento < current_date - v_dias) parado,
           false liberado
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where coalesce(s.saldo_mensalidade,0) > 0
      and coalesce(s.saldo_acordo,0) = 0
      and (v_ano is null or extract(year from s.venc_max) = v_ano)
      and not public.caso_protegido_redistribuicao(
            c.cpf_limpo, c.status_acionamento, c.nao_acionar,
            c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);
  -- Os laços abaixo procuram caso por valor dentro de um operador, milhares de
  -- vezes. Sem estes indices a simulacao vira varredura completa a cada escolha.
  create index on _base (dest_email, valor);
  create index on _base (valor) where dest_email is null;

  create temp table _op on commit drop as
    select u.email op_email,
           coalesce(max(b.de_nome), u.nome) op_nome,
           count(b.de_email)::numeric qtd,
           round(coalesce(sum(b.valor),0),2) saldo
    from public.usuarios u
    left join _base b on b.de_email = u.email
    where u.ativo and u.perfil = 'operador'
      and (v_ops is null or u.email = any(v_ops))
    group by u.email, u.nome;
  create temp table _op_antes on commit drop as select * from _op;

  select count(*), coalesce(sum(qtd),0)::int into v_n_ops, v_total_disp from _op;
  select count(*) into v_pool_total from _base where de_email is null;
  v_total_disp := v_total_disp + v_pool_total;
  v_alvo_ef := case when v_n_ops = 0 then v_alvo
                    else least(v_alvo, floor(v_total_disp::numeric / v_n_ops)::int) end;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  -- FASE 1 -- RETIRAR. Quem esta acima do alvo solta casos parados para o pool.
  -- QUAIS casos: os que aproximam o saldo do operador da media da equipe. Antes
  -- soltava sempre o mais antigo e mais barato, cego ao valor -- e era por isso
  -- que o equilibrio de valor nunca saia do lugar.
  for v_op in select * from _op where qtd > v_alvo_ef order by qtd desc loop
    select qtd into v_qtd_atual from _op where op_email = v_op.op_email;
    v_faltam := (v_qtd_atual - v_alvo_ef)::int;
    loop
      exit when v_faltam <= 0;
      select avg(saldo) into v_saldo_alvo from _op;
      select saldo into v_saldo_atual from _op where op_email = v_op.op_email;
      -- Quanto ainda precisa sair para este operador cair na media da equipe,
      -- dividido pelos casos que ele ainda tem de soltar: o tamanho ideal do
      -- proximo caso a sair. Negativo (ja esta abaixo da media) => solta o mais
      -- barato que houver.
      v_ideal := (v_saldo_atual - v_saldo_alvo) / v_faltam;
      select caso_id, valor into v_c from (
          (select caso_id, valor from _base
             where dest_email = v_op.op_email and parado and not liberado
               and valor <= v_ideal
             order by valor desc limit 1)
          union all
          (select caso_id, valor from _base
             where dest_email = v_op.op_email and parado and not liberado
               and valor > v_ideal
             order by valor asc limit 1)
        ) t order by abs(valor - v_ideal) limit 1;
      exit when v_c.caso_id is null;  -- acabaram os parados: fica acima do alvo
      update _base set dest_email = null, liberado = true where caso_id = v_c.caso_id;
      update _op set qtd = qtd - 1, saldo = saldo - v_c.valor where op_email = v_op.op_email;
      v_movs := v_movs + 1;
      v_faltam := v_faltam - 1;
    end loop;
  end loop;

  -- FASE 2 -- COMPLETAR. Quem esta abaixo do alvo puxa do pool. Escolhe o caso
  -- que aproxima o saldo da media; entre valores equivalentes, divida mais
  -- recente primeiro (a regra da gestao continua, como desempate).
  for v_op in select * from _op where qtd < v_alvo_ef order by saldo asc, qtd asc loop
    select qtd into v_qtd_atual from _op where op_email = v_op.op_email;
    v_faltam := (v_alvo_ef - v_qtd_atual)::int;
    loop
      exit when v_faltam <= 0;
      select avg(saldo) into v_saldo_alvo from _op;
      select saldo into v_saldo_atual from _op where op_email = v_op.op_email;
      v_ideal := (v_saldo_alvo - v_saldo_atual) / v_faltam;
      select caso_id, valor into v_c from (
          (select caso_id, valor from _base
             where dest_email is null and valor <= v_ideal
             order by valor desc, venc_max desc nulls last limit 1)
          union all
          (select caso_id, valor from _base
             where dest_email is null and valor > v_ideal
             order by valor asc, venc_max desc nulls last limit 1)
        ) t order by abs(valor - v_ideal) limit 1;
      exit when v_c.caso_id is null;  -- pool vazio
      update _base set dest_email = v_op.op_email where caso_id = v_c.caso_id;
      update _op set qtd = qtd + 1, saldo = saldo + v_c.valor where op_email = v_op.op_email;
      v_movs := v_movs + 1;
      v_faltam := v_faltam - 1;
    end loop;
  end loop;

  -- FASE 3 -- AJUSTE FINO. Troca sem alterar a contagem: um caso do mais rico
  -- pelo do mais pobre. So mexe em caso ja parado ou vindo do pool, nunca em
  -- caso dentro dos 10 dias de fidelizacao do dono atual.
  loop
    v_iter := v_iter + 1; exit when v_iter > 20000;
    select op_email into v_rich from _op order by saldo desc limit 1;
    select op_email into v_poor from _op order by saldo asc  limit 1;
    exit when v_rich = v_poor;
    v_gap := (select saldo from _op where op_email=v_rich) - (select saldo from _op where op_email=v_poor);
    exit when v_gap <= 0;
    select caso_id, valor into v_cl from _base
      where dest_email=v_poor and (parado or de_email is null)
      order by valor asc limit 1;
    exit when v_cl.caso_id is null;
    -- Uma troca move `delta` de um lado para o outro: a distancia entre os dois
    -- cai 2*delta. O melhor par e o que chega mais perto de metade da distancia
    -- sem passar dela. Antes pegava-se o caso MAIS CARO do rico e, quando ele
    -- passava do ponto, a fase inteira era abortada com `exit`.
    select caso_id, valor into v_ch from _base
      where dest_email=v_rich and (parado or de_email is null)
        and valor > v_cl.valor and (valor - v_cl.valor) <= v_gap/2
      order by valor desc limit 1;
    exit when v_ch.caso_id is null;  -- nenhum par util sobrou
    v_delta := v_ch.valor - v_cl.valor;
    exit when v_delta <= 0;
    update _base set dest_email=v_poor where caso_id=v_ch.caso_id;
    update _base set dest_email=v_rich where caso_id=v_cl.caso_id;
    update _op set saldo=saldo - v_delta where op_email=v_rich;
    update _op set saldo=saldo + v_delta where op_email=v_poor;
    v_movs := v_movs + 2;
  end loop;

  v_id_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _op));
  v_id_sal := public.calibragem_indice_equilibrio(array(select saldo from _op));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'NIVELAMENTO_500', 'ano', v_ano, 'alvo', v_alvo,
    'alvo_efetivo', v_alvo_ef, 'pool_total', v_pool_total, 'total_disponivel', v_total_disp,
    'dias_sem_acionamento', v_dias,
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'antes',  (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op_antes),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object('op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _op),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id',b.caso_id,'cpf',b.cpf,'nome',b.nome,'valor',b.valor,
        'de_email',b.de_email,'de_nome',b.de_nome,
        'para_email',b.dest_email,'para_nome',d.op_nome,
        'motivo', case
          when b.dest_email is null then 'Retirado por nivelamento (parado +'||v_dias||'d) - sem responsavel'
          when b.de_email  is null then 'Recebido do pool (divida recente)'
          else 'Realocado por nivelamento' end
      ) order by b.de_email nulls last, b.valor desc),'[]')
      from _base b left join _op d on d.op_email = b.dest_email
      where b.dest_email is distinct from b.de_email),
    'total_movimentacoes', (select count(*) from _base where dest_email is distinct from de_email)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'), p_criterio, v_resultado, 'RASCUNHO')
  returning id into v_sim_id;
  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end; $function$;

-- ------------------------------------------------------------------
-- 2. Executor: contar caso DISTINTO dos dois lados, para o lote fechar.
-- ------------------------------------------------------------------
create or replace function public.calibragem_executar_nivelamento_lote_impl(p_id uuid, p_tamanho integer default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '90s'
as $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_movidos int := 0; v_pulados int := 0; v_total int; v_feitos int; v_restantes int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then raise exception 'Simulação precisa estar APROVADA ou EXECUTANDO (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));

  if v_sim.status = 'APROVADA' then
    update public.calibragem_simulacoes set status='EXECUTANDO' where id=p_id;
  end if;

  -- Total por CASO DISTINTO. A lista de movimentacoes pode citar o mesmo caso
  -- duas vezes (troca da fase 3, ou aluno com caso duplicado) e a auditoria
  -- grava o caso uma vez so. Contar linhas de um lado e casos distintos do
  -- outro deixava `restantes` preso num numero pequeno para sempre.
  select count(distinct (m->>'caso_id')) into v_total
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  perform set_config('calibragem.bypass_teto','on', true);

  create temp table _slice on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email, m->>'de_nome' de_nome,
         nullif(m->>'para_email','') para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m
  where not exists (
     select 1 from public.calibragem_auditoria a
     where a.simulacao_id=p_id and a.caso_id=(m->>'caso_id')::uuid
       and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'))
  order by (m->>'caso_id')
  limit p_tamanho;

  update _slice e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email is not distinct from e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Retirada so vale se o caso ja estiver fora dos 10 dias de fidelizacao.
    and (e.de_email is null or not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento));

  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _slice e where e.valido and c.id = e.caso_id and e.de_email is not null;

  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _slice e where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo,
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome, 'marcador','Retirado por nivelamento'),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _slice e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_movidos = row_count;

  -- Marca os pulados para não reprocessar (LEFT JOIN cobre caso inexistente)
  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor,
    'Pulado: caso já não pertence ao operador de origem, está protegido ou está dentro dos 10 dias de fidelização.',
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    '{}'::jsonb, '{}'::jsonb, v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _slice e left join public.casos c on c.id = e.caso_id where not e.valido;
  get diagnostics v_pulados = row_count;

  select count(distinct a.caso_id) into v_feitos
  from public.calibragem_auditoria a
  where a.simulacao_id=p_id and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO');
  v_restantes := greatest(v_total - v_feitos, 0);

  if v_restantes = 0 then
    update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  end if;

  return jsonb_build_object('id', p_id, 'movidos_lote', v_movidos, 'pulados_lote', v_pulados,
    'feitos', v_feitos, 'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end; $function$;

-- ------------------------------------------------------------------
-- 3. Desfazer: devolve cada caso ao dono anterior, em lotes curtos.
-- ------------------------------------------------------------------
create or replace function public.calibragem_desfazer_nivelamento_lote_impl(p_id uuid, p_tamanho integer default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '90s'
as $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_voltaram int := 0; v_pulados int := 0; v_total int; v_restantes int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para desfazer a Calibragem.';
  end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status not in ('EXECUTADA','EXECUTANDO','DESFAZENDO') then
    raise exception 'Só dá para desfazer um nivelamento que foi aplicado (atual: %).', v_sim.status;
  end if;
  -- Mesma trava do executor: desfazer e aplicar nunca correm juntos.
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));
  if v_sim.status <> 'DESFAZENDO' then
    update public.calibragem_simulacoes set status='DESFAZENDO' where id=p_id;
  end if;

  perform set_config('calibragem.bypass_teto','on', true);

  -- O que esta simulacao moveu e ainda nao foi devolvido.
  create temp table _volta on commit drop as
  select a.caso_id, a.cpf, a.nome_aluno, a.valor_caso,
         a.operador_anterior_email, a.operador_anterior_nome,
         a.operador_novo_email, a.operador_novo_nome, false as valido
  from public.calibragem_auditoria a
  where a.simulacao_id = p_id and a.evento = 'MOVIMENTACAO_NIVELAMENTO'
    and not exists (
      select 1 from public.calibragem_auditoria r
      where r.simulacao_id = p_id and r.caso_id = a.caso_id
        and r.evento in ('REVERSAO_NIVELAMENTO','PULADO_REVERSAO'))
  order by a.caso_id
  limit p_tamanho;

  -- So volta o caso que AINDA esta onde o nivelamento o deixou. Se o novo dono
  -- ja acionou e negociou, ou se o caso foi remanejado depois, nao se mexe --
  -- desfazer nao pode atropelar o trabalho feito desde entao.
  update _volta v set valido = true from public.casos c
  where c.id = v.caso_id
    and c.operador_email is not distinct from v.operador_novo_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  -- Voltou para o pool (nao tinha dono antes do nivelamento).
  update public.casos c
     set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador=null, nivelamento_em=null, nivelamento_simulacao_id=null
    from _volta v
   where v.valido and c.id = v.caso_id and v.operador_anterior_email is null;

  -- Voltou para o dono anterior.
  update public.casos c
     set operador_email=v.operador_anterior_email,
         operador_nome =v.operador_anterior_nome,
         operador      =upper(coalesce(v.operador_anterior_nome,'')),
         nivelamento_marcador=null, nivelamento_em=null, nivelamento_simulacao_id=null
    from _volta v
   where v.valido and c.id = v.caso_id and v.operador_anterior_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'REVERSAO_NIVELAMENTO', p_id, v.caso_id, c.aluno_id, v.cpf, v.nome_aluno,
    v.operador_novo_email, v.operador_novo_nome, v.operador_anterior_email, v.operador_anterior_nome,
    v.valor_caso, 'Nivelamento desfeito pela gestão: caso devolvido ao responsável anterior.',
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    jsonb_build_object('operador_email', v.operador_novo_email, 'operador_nome', v.operador_novo_nome),
    jsonb_build_object('operador_email', v.operador_anterior_email, 'operador_nome', v.operador_anterior_nome),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _volta v join public.casos c on c.id = v.caso_id where v.valido;
  get diagnostics v_voltaram = row_count;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_REVERSAO', p_id, v.caso_id, c.aluno_id, v.cpf, v.nome_aluno,
    v.operador_novo_email, v.operador_novo_nome, v.operador_anterior_email, v.operador_anterior_nome,
    v.valor_caso,
    'Não devolvido: o caso já saiu das mãos de quem o recebeu, está protegido (negociação, acordo, link, termo, pagamento) ou não existe mais.',
    upper(coalesce(v_sim.resultado->>'metrica','NIVELAMENTO_500')),
    '{}'::jsonb, '{}'::jsonb,
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
  from _volta v left join public.casos c on c.id = v.caso_id where not v.valido;
  get diagnostics v_pulados = row_count;

  select count(*) into v_total
  from public.calibragem_auditoria a
  where a.simulacao_id = p_id and a.evento = 'MOVIMENTACAO_NIVELAMENTO';

  select count(*) into v_restantes from (
    select a.caso_id from public.calibragem_auditoria a
    where a.simulacao_id = p_id and a.evento = 'MOVIMENTACAO_NIVELAMENTO'
      and not exists (
        select 1 from public.calibragem_auditoria r
        where r.simulacao_id = p_id and r.caso_id = a.caso_id
          and r.evento in ('REVERSAO_NIVELAMENTO','PULADO_REVERSAO'))
  ) x;

  if v_restantes = 0 then
    update public.calibragem_simulacoes
       set status='REVERTIDA',
           observacao = trim(coalesce(observacao,'') || ' | desfeito por ' || v_email || ' em ' || to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
     where id=p_id;
  end if;

  return jsonb_build_object('id', p_id, 'voltaram_lote', v_voltaram, 'pulados_lote', v_pulados,
    'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end; $function$;

create or replace function public.calibragem_desfazer_nivelamento_lote(p_id uuid, p_tamanho integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '90s'
as $function$
begin
  perform public.exigir_capacidade('desfazer nivelamento em lote');
  return public.calibragem_desfazer_nivelamento_lote_impl(p_id, p_tamanho);
end $function$;

-- Mesma politica das demais: a porta e do `authenticated` (e o gate de gestao
-- decide la dentro); a `_impl` nao e chamavel de fora.
revoke all on function public.calibragem_desfazer_nivelamento_lote(uuid, integer) from public, anon;
revoke all on function public.calibragem_desfazer_nivelamento_lote_impl(uuid, integer) from public, anon, authenticated;
grant execute on function public.calibragem_desfazer_nivelamento_lote(uuid, integer) to authenticated, service_role;
grant execute on function public.calibragem_desfazer_nivelamento_lote_impl(uuid, integer) to service_role;

-- ------------------------------------------------------------------
-- 4. Fecha as simulacoes que ja foram inteiramente aplicadas e ficaram
--    presas em EXECUTANDO por causa da contagem errada (caso de 20/08).
-- ------------------------------------------------------------------
update public.calibragem_simulacoes s
   set status = 'EXECUTADA',
       executado_em = coalesce(s.executado_em, (
         select max(a.registrado_em) from public.calibragem_auditoria a where a.simulacao_id = s.id))
 where s.status = 'EXECUTANDO'
   and (select count(distinct (m->>'caso_id'))
          from jsonb_array_elements(s.resultado->'movimentacoes') m)
       <= (select count(distinct a.caso_id) from public.calibragem_auditoria a
            where a.simulacao_id = s.id
              and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'));
