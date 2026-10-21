-- ONDA 1 · SIMULAÇÃO DO LOTE A — dar dono operacional a quem está sem.
--
-- POR QUE UMA FUNÇÃO NOVA, E NÃO UMA DAS QUE JÁ EXISTEM
--
-- Nenhuma das cinco simulações existentes expressa este recorte. Medido em
-- 21/10/2026, antes de escrever uma linha:
--
--   calibragem_simular            rebalanceia ENTRE os sete, por QTD ou SALDO.
--                                 O pool exige `operador_email is not null`:
--                                 quem está sem dono não entra. Sem competência.
--   calibragem_simular_giro_2026  lança exceção -- GIRO_DESATIVADO em 29/09.
--   calibragem_simular_ano        idem calibragem_simular, com recorte de ano.
--   calibragem_simular_ano_parelho idem, com mapa de operadores fixo.
--   giro_2026_10_simular          a régua de competência é a CERTA e é dela que
--                                 esta função herda -- mas o universo não é:
--                                 escolheria 3.731 CPFs, dos quais 3.730 JÁ têm
--                                 operador ativo e só 1 está fora da operação.
--                                 E exclui quem tem parcela de acordo viva, que
--                                 são 185 dos 259 do lote A.
--
-- O QUE ESTA FUNÇÃO FAZ DE DIFERENTE
--
--   1. O universo é o INVERSO do giro: só CPF SEM responsável operacional ativo.
--   2. INCLUI quem tem acordo vivo -- o giro exclui. O acordo entra como
--      terceira dimensão, com saldo próprio, SEM competência inventada:
--      parcela não carrega safra, só o título negociado carrega.
--   3. Exclui quem está bloqueado, encerrado, suspenso, jurídico ou com marca
--      de giro viva -- os 43 do lote A ficam de fora, por decisão da gestão.
--   4. Exclui quem não tem caso nenhum -- o lote B (510) é criação de caso,
--      outra frente, e não entra aqui.
--
-- O QUE ELA HERDA DO GIRO DE 16/10 (20261016115142), sem reescrever
--
--   * a régua do semestre híbrido (`prime_titulo_semestre.semestre`, vencimento
--     como fallback) e o recorte de mensalidade aberta;
--   * a distribuição em serpentina por valor decrescente, que equilibra
--     quantidade e valor ao mesmo tempo;
--   * o formato do resultado e o registro em `calibragem_simulacoes` como
--     RASCUNHO, com `metrica` própria.
--
-- ESTA FUNÇÃO NÃO MOVE NINGUÉM. É SELECT mais UM insert de linha de simulação.
-- Não há UPDATE em `casos`, `acordos`, `alunos` ou qualquer tabela de operação.
-- A movimentação real é outra frente, que exige simulação APROVADA.
--
-- Reversível: supabase/rollbacks/20261021180000_onda1_simular.rollback.sql

create or replace function public.onda1_simular(p_criterio jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_metodo  text := coalesce(nullif(p_criterio->>'semestre_metodo',''), 'hibrido');
  v_fid_ate date := coalesce(nullif(p_criterio->>'fidelizacao_ate','')::date,
                             ((now() at time zone 'America/Sao_Paulo')::date + 10));
  v_ops     text[];
  v_n_ops   int;
  -- A confirmacao financeira aberta e dinheiro em transito: por padrao o caso
  -- NAO troca de dono no meio dela. A gestao pode sobrepor por criterio.
  v_inc_conf boolean := coalesce((p_criterio->>'incluir_confirmacao_aberta')::boolean, false);
  v_sim_id  uuid;
  v_res     jsonb;
  v_estouro text;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular a Onda 1.' using errcode = '42501';
  end if;
  if v_metodo not in ('hibrido','vencimento') then
    raise exception 'semestre_metodo deve ser hibrido ou vencimento (recebido: %).', v_metodo;
  end if;
  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  -- Operadores que podem receber. `slot` e a posicao na serpentina.
  create temp table _ops on commit drop as
  select row_number() over (order by u.email) - 1 as slot, u.email, u.nome
    from public.usuarios u
   where u.ativo and u.perfil = 'operador'
     and coalesce(u.recebe_novos_casos, true)
     and (v_ops is null or u.email = any(v_ops));
  select count(*) into v_n_ops from _ops;
  if v_n_ops = 0 then raise exception 'Nenhum operador ativo para receber a Onda 1.'; end if;

  -- MENSALIDADE 2026, regua identica a do giro de 16/10.
  create temp table _tit on commit drop as
  select t.aluno_id,
         round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) valor,
         coalesce(case when v_metodo = 'vencimento' then null else ps.semestre end,
                  case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
                       when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2'
                  end) semestre
    from public.acordos_titulos t
    left join public.prime_titulo_semestre ps on ps.boleto = t.documento
   where upper(coalesce(t.situacao,'')) = 'ABERTO'
     and lower(coalesce(t.status,'')) = 'em_aberto'
     and t.acordo_id is null
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = t.id and coalesce(v.ativo, true))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  create temp table _mens on commit drop as
  select aluno_id,
         count(*) filter (where semestre = '2026/1') t1,
         count(*) filter (where semestre = '2026/2') t2,
         round(coalesce(sum(valor) filter (where semestre = '2026/1'),0),2) v1,
         round(coalesce(sum(valor) filter (where semestre = '2026/2'),0),2) v2
    from _tit
   where semestre in ('2026/1','2026/2') and valor > 0 and aluno_id is not null
   group by aluno_id;

  -- ACORDO ligado a titulo de 2026, com parcela VIVA. O saldo e somado UMA VEZ
  -- POR ACORDO: juntar parcelas direto com os titulos multiplica a parcela por
  -- cada titulo ligado e infla o saldo (medido: R$ 3,97 mi contra R$ 1,08 mi).
  create temp table _ac_id on commit drop as
  select distinct a.id acordo_id, a.aluno_id
    from public.acordos a
    join public.acordo_titulo_vinculo v on v.acordo_id = a.id and coalesce(v.ativo,true)
    join public.acordos_titulos t on t.id = v.titulo_id
    left join public.prime_titulo_semestre ps on ps.boleto = t.documento
   where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
     and a.aluno_id is not null
     and coalesce(case when v_metodo = 'vencimento' then null else ps.semestre end,
                  case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
                       when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2'
                  end) in ('2026/1','2026/2');

  create temp table _ac on commit drop as
  select aluno_id, round(sum(saldo),2) sac
    from (select i.acordo_id, i.aluno_id, coalesce(sum(p.valor),0) saldo
            from _ac_id i
            left join public.parcelas p on p.acordo_id = i.acordo_id and public.parcela_viva(p.status)
           group by i.acordo_id, i.aluno_id) x
   group by aluno_id
  having sum(saldo) > 0;

  -- Universo: quem tem mensalidade 2026 aberta OU acordo vivo de 2026.
  create temp table _aluno on commit drop as
  select coalesce(m.aluno_id, a.aluno_id) aluno_id,
         coalesce(m.t1,0) t1, coalesce(m.t2,0) t2,
         coalesce(m.v1,0) v1, coalesce(m.v2,0) v2,
         coalesce(a.sac,0) sac
    from _mens m
    full join _ac a on a.aluno_id = m.aluno_id;

  -- Casos desses alunos, com as guardas que decidem quem entra.
  create temp table _caso on commit drop as
  select c.id caso_id, c.aluno_id, c.operador_email de_email, c.operador_nome de_nome,
         coalesce(c.nome, c.nome_aluno) nome, coalesce(c.cpf_limpo, c.cpf) cpf,
         coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'), ''),
                  'caso:' || c.id::text) cpf_caso,
         public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) protegido,
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
           c.status_financeiro, c.status_jornada) encerrado,
         coalesce(c.nao_acionar,false) nao_acionar,
         public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate) marca_viva,
         exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                  where s.aluno_id = c.aluno_id::text
                    and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) confirmacao_aberta,
         exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(c.operador_email)
                    and u.ativo and u.perfil = 'operador') dono_ativo
    from public.casos c
   where c.aluno_id in (select aluno_id from _aluno);

  create temp table _chave on commit drop as
  select aluno_id, min(cpf_caso) cpf_chave from _caso group by aluno_id;

  -- LOTE A. Cada recusa tem um motivo declarado:
  --   dono ativo            ja esta na operacao -- nao e caso de dar dono
  --   sem caso              lote B, criacao de caso, outra frente
  --   nao_acionar           bloqueio de cobranca
  --   encerrado             suspensao, cancelamento, juridico
  --   marca de giro viva    fidelizacao de lote em curso: nao se mexe
  --   confirmacao aberta    dinheiro em transito (sobreponivel por criterio)
  --
  -- POR QUE `caso_protegido_redistribuicao` NAO E USADA COMO FILTRO CEGO AQUI.
  -- Ela devolve true para QUALQUER aluno com acordo ATIVO. Medido em
  -- 21/10/2026, dentro dos 259 do lote A: 242 seriam barrados so por essa
  -- clausula -- justamente o grupo que a gestao mandou INCLUIR. E a razao de ser
  -- daquela protecao e nao TIRAR um caso de quem ja o trabalha; aqui nao ha de
  -- quem tirar, o caso esta sem dono. As clausulas dela que continuam valendo
  -- entram EXPLICITAS acima, uma a uma, em vez de por um booleano que mistura
  -- seis motivos diferentes. Medido no mesmo dia: baixa aguardando barra 0 e
  -- link vivo barra 0 dentro do lote A; confirmacao aberta barra 39.
  create temp table _elegivel on commit drop as
  select a.*, k.cpf_chave
    from _aluno a
    join _chave k on k.aluno_id = a.aluno_id
   where not exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.dono_ativo)
     and exists     (select 1 from _caso c where c.aluno_id = a.aluno_id)
     and not exists (select 1 from _caso c where c.aluno_id = a.aluno_id
                       and (c.encerrado or c.nao_acionar or c.marca_viva
                         or (c.confirmacao_aberta and not v_inc_conf)));

  -- Um aluno pode ter mais de um caso; a unidade de distribuicao e o CPF, para
  -- o responsavel operacional ficar UNICO por aluno.
  create temp table _cpf on commit drop as
  select cpf_chave,
         round(sum(v1),2) s1, round(sum(v2),2) s2, round(sum(sac),2) sac,
         bool_or(t1 > 0) tem1, bool_or(t2 > 0) tem2,
         round(sum(v1)+sum(v2)+sum(sac),2) valor
    from _elegivel group by cpf_chave;
  alter table _cpf add column slot int;

  -- PASSADA A -- 2026/2 manda, serpentina por valor decrescente.
  with fila as (select cpf_chave, row_number() over (order by s2 desc, cpf_chave) - 1 r
                  from _cpf where tem2)
  update _cpf c set slot = case when (f.r / v_n_ops) % 2 = 0 then f.r % v_n_ops
                                else v_n_ops - 1 - (f.r % v_n_ops) end
    from fila f where f.cpf_chave = c.cpf_chave;

  -- PASSADA B -- 2026/1 completa por cota, alternando por saldo ja atribuido.
  with tot_a as (select o.slot, coalesce(sum(c.s1 + c.s2),0) t, count(c.cpf_chave) q
                   from _ops o left join _cpf c on c.slot = o.slot group by o.slot),
       par as (select count(*) n, count(*) / v_n_ops base, count(*) % v_n_ops rem
                 from _cpf where tem1 or tem2),
       alvo as (select slot, q, t, (select base from par)
                       + case when row_number() over (order by t asc) <= (select rem from par) then 1 else 0 end tgt
                  from tot_a),
       vagas as (select slot, t, generate_series(1, tgt - q) k from alvo where tgt - q > 0),
       vagas_ord as (select slot, row_number() over (order by k asc,
                       case when k % 2 = 1 then t else -t end asc) - 1 pos from vagas),
       fila_b as (select cpf_chave, row_number() over (order by s1 desc, cpf_chave) - 1 r
                    from _cpf where tem1 and not tem2)
  update _cpf c set slot = v.slot
    from fila_b f join vagas_ord v on v.pos = f.r
   where f.cpf_chave = c.cpf_chave;

  -- PASSADA C -- so acordo, sem competencia. Vai para quem tem MENOS carga
  -- total projetada, que e o que fecha a dispersao de quantidade.
  with carga as (
    select o.slot,
           (select count(*) from public.casos c
             where c.operador_email = o.email
               and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
                     c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
               and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                     c.status_acionamento, c.status_financeiro, c.status_jornada))
           + (select count(*) from _cpf c where c.slot = o.slot) projetado
      from _ops o),
    n as (select count(*) q from _cpf where slot is null),
    cota as (select slot, projetado,
                    (select q from n) / v_n_ops
                    + case when row_number() over (order by projetado asc, slot) <= (select q from n) % v_n_ops
                           then 1 else 0 end tgt
               from carga),
    vagas as (select slot, projetado, generate_series(1, tgt) k from cota where tgt > 0),
    vagas_ord as (select slot, row_number() over (order by k asc, projetado asc, slot) - 1 pos from vagas),
    fila_c as (select cpf_chave, row_number() over (order by sac desc, cpf_chave) - 1 r
                 from _cpf where slot is null)
  update _cpf c set slot = v.slot
    from fila_c f join vagas_ord v on v.pos = f.r
   where f.cpf_chave = c.cpf_chave;

  if exists (select 1 from _cpf where slot is null) then
    raise exception 'Onda 1: % CPFs ficaram sem operador na distribuição.',
      (select count(*) from _cpf where slot is null);
  end if;

  -- Os casos que a execucao futura moveria. Aqui so entra no relatorio.
  create temp table _mov on commit drop as
  select ca.caso_id, ca.cpf, ca.nome, ca.de_email, ca.de_nome,
         cp.cpf_chave, o.email para_email, o.nome para_nome, cp.valor,
         case when cp.tem1 and cp.tem2 then 'Onda 1 · 2026/1 e 2026/2'
              when cp.tem1 then 'Onda 1 · 2026/1'
              when cp.tem2 then 'Onda 1 · 2026/2'
              else 'Onda 1 · acordo sem competência' end
         || case when ca.de_email is null then ': estava sem responsável'
                 else ': estava com ' || ca.de_email end motivo
    from _caso ca
    join _chave k on k.aluno_id = ca.aluno_id
    join _cpf  cp on cp.cpf_chave = k.cpf_chave
    join _ops  o  on o.slot = cp.slot
   where ca.aluno_id in (select aluno_id from _elegivel);

  -- TETO: recusa antes de gravar se algum operador estouraria.
  create temp table _carga on commit drop as
  select o.email op_email, o.nome op_nome, o.slot,
         (select count(*) from public.casos c
           where c.operador_email = o.email
             and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
                   c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
             and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                   c.status_acionamento, c.status_financeiro, c.status_jornada)) ativos_antes,
         (select count(*) from _mov m where m.para_email = o.email) entram,
         public.calibragem_teto_operador(o.email) teto
    from _ops o;

  select string_agg(op_nome || ' (' || (ativos_antes + entram) || ' > ' || teto || ')', ', ')
    into v_estouro from _carga where ativos_antes + entram > teto;
  if v_estouro is not null then
    raise exception 'Onda 1: a distribuição passaria do teto em %. Nada foi gravado.', v_estouro;
  end if;

  select jsonb_build_object(
    'metrica', 'ONDA1_LOTE_A',
    'criterio', p_criterio,
    'semestre_metodo', v_metodo,
    'fidelizacao_ate', v_fid_ate,
    'operadores', v_n_ops,
    'universo', jsonb_build_object(
      'alunos_com_divida_2026', (select count(*) from _aluno),
      'lote_a_elegivel',        (select count(*) from _elegivel),
      'cpfs_a_distribuir',      (select count(*) from _cpf),
      'casos_envolvidos',       (select count(*) from _mov)),
    'fora_da_onda', jsonb_build_object(
      'ja_tem_dono_ativo', (select count(*) from _aluno a
                             where exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.dono_ativo)),
      'sem_caso_lote_b',   (select count(*) from _aluno a
                             where not exists (select 1 from _caso c where c.aluno_id = a.aluno_id)),
      'bloqueado_ou_encerrado', (select count(*) from _aluno a
                             where not exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.dono_ativo)
                               and exists (select 1 from _caso c where c.aluno_id = a.aluno_id)
                               and exists (select 1 from _caso c where c.aluno_id = a.aluno_id
                                             and (c.encerrado or c.nao_acionar or c.marca_viva))),
      'confirmacao_financeira_aberta', (select count(*) from _aluno a
                             where not exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.dono_ativo)
                               and exists (select 1 from _caso c where c.aluno_id = a.aluno_id)
                               and not exists (select 1 from _caso c where c.aluno_id = a.aluno_id
                                             and (c.encerrado or c.nao_acionar or c.marca_viva))
                               and exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.confirmacao_aberta)),
      'com_acordo_ativo_INCLUIDOS', (select count(*) from _elegivel e where e.sac > 0)),
    'incluir_confirmacao_aberta', v_inc_conf,
    -- Os retidos pela confirmacao financeira ficam IDENTIFICADOS, para a gestao
    -- reavaliar quando a pendencia fechar. Nao ha liberacao automatica: enquanto
    -- a solicitacao estiver aberta eles continuam fora, e a proxima simulacao os
    -- traz de volta sozinha se a pendencia tiver sido resolvida. Um aluno pode
    -- ter mais de uma solicitacao aberta -- por isso a contagem vem junto.
    'retidos_confirmacao', (select coalesce(jsonb_agg(jsonb_build_object(
          'aluno_id', x.aluno_id, 'cpf', public.mask_cpf(x.cpf), 'nome', x.nome,
          'solicitacoes_abertas', x.n) order by x.nome),'[]')
       from (select a.aluno_id,
                    (select min(c.cpf)  from _caso c where c.aluno_id = a.aluno_id) cpf,
                    (select min(c.nome) from _caso c where c.aluno_id = a.aluno_id) nome,
                    (select count(*) from public.solicitacoes_confirmacao_pagamento s
                      where s.aluno_id = a.aluno_id::text
                        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) n
               from _aluno a
              where not exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.dono_ativo)
                and exists (select 1 from _caso c where c.aluno_id = a.aluno_id)
                and not exists (select 1 from _caso c where c.aluno_id = a.aluno_id
                                  and (c.encerrado or c.nao_acionar or c.marca_viva))
                and exists (select 1 from _caso c where c.aluno_id = a.aluno_id and c.confirmacao_aberta)) x),
    'antes', (select coalesce(jsonb_agg(jsonb_build_object(
                'op_email', op_email, 'op_nome', op_nome, 'casos_ativos', ativos_antes,
                'teto', teto, 'folga', teto - ativos_antes) order by op_nome),'[]') from _carga),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object(
                'op_email', c.op_email, 'op_nome', c.op_nome,
                'recebe', c.entram,
                'casos_ativos', c.ativos_antes + c.entram,
                'folga', c.teto - (c.ativos_antes + c.entram),
                'cpfs_2026_1', (select count(*) from _cpf x where x.slot = c.slot and x.tem1),
                'cpfs_2026_2', (select count(*) from _cpf x where x.slot = c.slot and x.tem2),
                'cpfs_so_acordo', (select count(*) from _cpf x where x.slot = c.slot and not x.tem1 and not x.tem2),
                'saldo_2026_1', (select round(coalesce(sum(x.s1),0),2) from _cpf x where x.slot = c.slot),
                'saldo_2026_2', (select round(coalesce(sum(x.s2),0),2) from _cpf x where x.slot = c.slot),
                'saldo_acordo', (select round(coalesce(sum(x.sac),0),2) from _cpf x where x.slot = c.slot)
              ) order by c.op_nome),'[]') from _carga c),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
                'caso_id', caso_id, 'cpf', public.mask_cpf(cpf), 'nome', nome,
                'de_email', de_email, 'para_email', para_email, 'valor', valor, 'motivo', motivo
              ) order by para_email, valor desc),'[]') from _mov),
    'total_movimentacoes', (select count(*) from _mov)
  ) into v_res;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt() ->> 'email','server'), coalesce(auth.jwt() ->> 'email','server'),
          p_criterio, v_res, 'RASCUNHO')
  returning id into v_sim_id;

  return jsonb_build_object('simulacao_id', v_sim_id) || v_res;
end;
$function$;

comment on function public.onda1_simular(jsonb) is
  'Simula a Onda 1: da dono operacional aos CPFs de 2026/1 e 2026/2 que estao '
  'SEM responsavel ativo, incluindo quem tem acordo vivo. Herda do giro de '
  '16/10 a regua do semestre hibrido e a serpentina por valor. NAO MOVE '
  'NINGUEM -- e SELECT mais um registro RASCUNHO em calibragem_simulacoes. '
  'Exclui quem ja tem dono ativo, quem nao tem caso (lote B) e quem esta '
  'bloqueado, encerrado, suspenso, juridico, protegido ou com marca de giro '
  'viva. Recusa antes de gravar se a distribuicao passaria do teto.';
