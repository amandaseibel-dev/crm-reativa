-- GIRO DE CARTEIRA 2026 (pedido da gestão em 10/09/2026)
--
-- Não é a Calibragem/nivelamento: aqui a carteira 2026 é REDISTRIBUÍDA INTEIRA.
--   * 2026/1 (venc. jan-jun) e 2026/2 (venc. jul-dez) são divididos entre todos
--     os operadores ativos com a MESMA quantidade de CPFs e o MESMO valor.
--   * Nada sobra: o resto da divisão vai para os primeiros operadores da fila.
--   * Dívida de anos anteriores SAI da carteira (volta ao pool sem responsável).
--   * Acordo NÃO se mexe: quem fechou continua dono. Aluno com parcela de acordo
--     em aberto fica de fora do giro inteiro.
--   * O prazo de 10 dias de fidelização NÃO vale no giro (decisão da gestão):
--     é justamente o ponto de girar. As demais proteções continuam de pé
--     (negociação, acordo ativo, link, termo, confirmação de pagamento).
--
-- O ano do aluno é o vencimento MAIS RECENTE em aberto (venc_max) — pelo mais
-- antigo, quem deve 2024 e 2026 sumiria do recorte de 2026.
--
-- A unidade da divisão é o CPF, não a ficha: aluno com ficha duplicada vai
-- inteiro para o mesmo operador, senão "mesma quantidade de CPFs" seria mentira.

-- ---------------------------------------------------------------- SIMULAÇÃO
create or replace function public.calibragem_simular_giro_2026(p_criterio jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ano   int  := coalesce(nullif(p_criterio->>'ano','')::int, 2026);
  v_ops   text[];
  v_n_ops int;
  v_sim_id uuid;
  v_resultado jsonb;
  v_ia_qtd numeric; v_id_qtd numeric; v_ia_sal numeric; v_id_sal numeric;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular o giro de carteira.';
  end if;

  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  -- Operadores que recebem, em ordem estável (o slot 0 é sempre o mesmo e-mail).
  create temp table _ops on commit drop as
  select row_number() over (order by u.email) - 1 as slot, u.email, u.nome
    from public.usuarios u
   where u.ativo and u.perfil = 'operador'
     and (v_ops is null or u.email = any(v_ops));
  select count(*) into v_n_ops from _ops;
  if v_n_ops = 0 then raise exception 'Nenhum operador ativo para receber o giro.'; end if;

  -- Casos elegíveis: mensalidade viva, sem parcela de acordo em aberto e sem
  -- proteção. Fidelização de propósito fora da conta.
  create temp table _caso on commit drop as
  select c.id caso_id, c.aluno_id,
         c.operador_email de_email, c.operador_nome de_nome,
         coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'), ''), 'caso:' || c.id::text) cpf_chave,
         coalesce(c.cpf_limpo, c.cpf) cpf,
         coalesce(c.nome, c.nome_aluno) nome,
         round(coalesce(s.saldo_mensalidade,0),2) valor,
         s.venc_max
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where coalesce(s.saldo_mensalidade,0) > 0
     and coalesce(s.saldo_acordo,0) = 0
     and not public.caso_protegido_redistribuicao(
           c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
     -- Caso concluido nao e carteira: fica de fora da contagem e do giro.
     and not public.caso_encerrado_operacional(
           c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);

  -- O CPF é a unidade: semestre pelo vencimento mais recente do CPF inteiro.
  create temp table _cpf on commit drop as
  select cpf_chave,
         max(venc_max) venc_max,
         round(sum(valor),2) valor,
         count(*) qtd_casos
    from _caso
   group by cpf_chave;

  alter table _cpf add column semestre text;
  alter table _cpf add column slot int;
  update _cpf set semestre = case
      when venc_max is null                     then 'ANTERIOR'
      when venc_max <  make_date(v_ano,1,1)     then 'ANTERIOR'
      when venc_max <  make_date(v_ano,7,1)     then v_ano || '/1'
      when venc_max <  make_date(v_ano+1,1,1)   then v_ano || '/2'
      else 'POSTERIOR' end;

  -- Serpentina: ordena por valor decrescente e distribui em zigue-zague. Dá
  -- quantidade igual (o resto cai nos primeiros slots) e valor quase igual,
  -- sem precisar de fase de troca depois.
  with fila as (
    select cpf_chave,
           row_number() over (partition by semestre order by valor desc, cpf_chave) - 1 r
      from _cpf
     where semestre in (v_ano || '/1', v_ano || '/2')
  )
  update _cpf c
     set slot = case when (f.r / v_n_ops) % 2 = 0
                     then  f.r % v_n_ops
                     else  v_n_ops - 1 - (f.r % v_n_ops) end
    from fila f where f.cpf_chave = c.cpf_chave;

  -- Destino de cada caso: o slot do seu CPF; fora do recorte de 2026, ninguém.
  create temp table _mov on commit drop as
  select ca.caso_id, ca.cpf, ca.nome, ca.valor, ca.de_email, ca.de_nome,
         cp.semestre, o.email para_email, o.nome para_nome,
         case when cp.semestre in ('ANTERIOR','POSTERIOR') then 'Retirado do giro: dívida fora de ' || v_ano
              when ca.de_email is null then 'Giro ' || cp.semestre || ': recebido do pool'
              else 'Giro ' || cp.semestre || ': carteira redistribuída' end motivo
    from _caso ca
    join _cpf  cp on cp.cpf_chave = ca.cpf_chave
    left join _ops o on o.slot = cp.slot;

  create temp table _antes on commit drop as
  select o.email op_email, o.nome op_nome,
         count(m.caso_id)::numeric qtd,
         round(coalesce(sum(m.valor),0),2) saldo
    from _ops o left join _mov m on m.de_email = o.email
   group by o.email, o.nome;

  create temp table _depois on commit drop as
  select o.email op_email, o.nome op_nome,
         count(m.caso_id)::numeric qtd,
         count(distinct m.cpf)::numeric cpfs,
         round(coalesce(sum(m.valor),0),2) saldo,
         count(m.caso_id) filter (where m.semestre = v_ano || '/1')::numeric qtd_s1,
         round(coalesce(sum(m.valor) filter (where m.semestre = v_ano || '/1'),0),2) saldo_s1,
         count(m.caso_id) filter (where m.semestre = v_ano || '/2')::numeric qtd_s2,
         round(coalesce(sum(m.valor) filter (where m.semestre = v_ano || '/2'),0),2) saldo_s2
    from _ops o left join _mov m on m.para_email = o.email
   group by o.email, o.nome;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _antes));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _antes));
  v_id_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _depois));
  v_id_sal := public.calibragem_indice_equilibrio(array(select saldo from _depois));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'GIRO_2026', 'ano', v_ano,
    'operadores', v_n_ops,
    'ignora_fidelizacao', true,
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'resumo', (select jsonb_object_agg(semestre, jsonb_build_object(
                 'casos', qtd, 'cpfs', cpfs, 'valor', valor))
                 from (select semestre, count(*) qtd, count(distinct cpf_chave) cpfs,
                              round(sum(valor),2) valor
                         from _cpf group by semestre) t),
    'antes',  (select coalesce(jsonb_agg(jsonb_build_object(
                 'op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _antes),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object(
                 'op_email',op_email,'op_nome',op_nome,'qtd',qtd,'cpfs',cpfs,'saldo',saldo,
                 'qtd_s1',qtd_s1,'saldo_s1',saldo_s1,'qtd_s2',qtd_s2,'saldo_s2',saldo_s2) order by op_nome),'[]') from _depois),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,
        'de_email',de_email,'de_nome',de_nome,
        'para_email',para_email,'para_nome',para_nome,
        'motivo',motivo) order by para_email nulls last, valor desc),'[]')
      from _mov where para_email is distinct from de_email),
    'total_movimentacoes', (select count(*) from _mov where para_email is distinct from de_email),
    'total_retiradas', (select count(*) from _mov where para_email is null and de_email is not null)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'),
          p_criterio || jsonb_build_object('tipo','GIRO_2026'), v_resultado, 'RASCUNHO')
  returning id into v_sim_id;

  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end;
$$;

-- ---------------------------------------------------------------- EXECUÇÃO
-- Igual ao executor do nivelamento, com uma diferença: o giro não pula caso
-- dentro dos 10 dias de fidelização. Grava o mesmo evento de auditoria
-- (MOVIMENTACAO_NIVELAMENTO) para que calibragem_desfazer_nivelamento_lote
-- desfaça o giro sem precisar de um segundo caminho de reversão.
create or replace function public.calibragem_executar_giro_lote_impl(p_id uuid, p_tamanho int default 150)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_movidos int := 0; v_pulados int := 0; v_total int; v_feitos int; v_restantes int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para executar o giro de carteira.';
  end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;

  select * into v_sim from public.calibragem_simulacoes where id = p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if coalesce(v_sim.resultado->>'metrica','') <> 'GIRO_2026' then
    raise exception 'Esta simulação não é um giro de carteira.';
  end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then
    raise exception 'Simulação precisa estar APROVADA ou EXECUTANDO (atual: %).', v_sim.status;
  end if;

  -- Mesma trava do nivelamento: aplicar e desfazer nunca correm juntos.
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));
  if v_sim.status = 'APROVADA' then
    update public.calibragem_simulacoes set status='EXECUTANDO' where id=p_id;
  end if;

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
      where a.simulacao_id = p_id and a.caso_id = (m->>'caso_id')::uuid
        and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'))
   order by (m->>'caso_id')
   limit p_tamanho;

  -- Sem o teste de fidelização: no giro os 10 dias não contam.
  update _slice e set valido = true from public.casos c
   where c.id = e.caso_id
     and c.operador_email is not distinct from e.de_email
     and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  update public.casos c
     set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por giro de carteira', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _slice e where e.valido and c.id = e.caso_id and e.de_email is not null;

  update public.casos c
     set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _slice e where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo, 'GIRO_2026',
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome,
                       'marcador','Retirado por giro de carteira'),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_movidos = row_count;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor,
    'Pulado no giro: o caso já não pertence ao operador de origem ou ficou protegido (negociação, acordo, link, termo, pagamento).',
    'GIRO_2026', '{}'::jsonb, '{}'::jsonb,
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e left join public.casos c on c.id = e.caso_id where not e.valido;
  get diagnostics v_pulados = row_count;

  select count(distinct a.caso_id) into v_feitos
    from public.calibragem_auditoria a
   where a.simulacao_id = p_id and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO');
  v_restantes := greatest(v_total - v_feitos, 0);

  if v_restantes = 0 then
    update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  end if;

  return jsonb_build_object('id', p_id, 'movidos_lote', v_movidos, 'pulados_lote', v_pulados,
    'feitos', v_feitos, 'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end;
$$;

create or replace function public.calibragem_executar_giro_lote(p_id uuid, p_tamanho int default 150)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.exigir_capacidade('executar giro de carteira em lote');
  return public.calibragem_executar_giro_lote_impl(p_id, p_tamanho);
end;
$$;

revoke all on function public.calibragem_simular_giro_2026(jsonb) from public, anon, authenticated;
revoke all on function public.calibragem_executar_giro_lote(uuid, int) from public, anon, authenticated;
revoke all on function public.calibragem_executar_giro_lote_impl(uuid, int) from public, anon, authenticated;
grant execute on function public.calibragem_simular_giro_2026(jsonb) to authenticated;
grant execute on function public.calibragem_executar_giro_lote(uuid, int) to authenticated;

comment on function public.calibragem_simular_giro_2026(jsonb) is
  'Giro de carteira: divide 2026/1 e 2026/2 em partes iguais (CPFs e valor) entre os operadores ativos, retira os anos anteriores e não toca em quem tem acordo. Grava RASCUNHO em calibragem_simulacoes.';
comment on function public.calibragem_executar_giro_lote(uuid, int) is
  'Aplica em lotes uma simulação de giro APROVADA. Ao contrário do nivelamento, ignora o prazo de 10 dias de fidelização; as demais proteções continuam valendo. Desfazer: calibragem_desfazer_nivelamento_lote.';
