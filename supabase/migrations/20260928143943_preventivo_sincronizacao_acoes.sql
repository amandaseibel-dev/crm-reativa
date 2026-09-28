-- =============================================================================
-- PREVENTIVO — sincronização com o Prime, painel de resultados e ações
-- =============================================================================
--
-- O QUE A API DO PRIME DÁ E O QUE NÃO DÁ (conferido AO VIVO em 28/09/2026,
-- `GET /students/{registration}`, via a Edge Function `prime-acordo`):
--
--   `financialStatement` tem 13 campos e NENHUM é situação, status ou saldo
--   em aberto: documentNumber, dueDate, grossAmount, discountAmount,
--   penaltyAmount, interestAmount, honorariumAmount, netAmount, paymentDate,
--   paidAmount, boleto, isAgreementInstallment, carrier.
--
--   `paymentDate` vem preenchido em 100% das linhas — inclusive em título que
--   ainda vai vencer (0 de 302.477 linhas do portador 95 com data nula, medido
--   em `prime_extrato` no espelho de 28/09). Não é prova de pagamento.
--
--   `paidAmount` é valor de tabela / dívida corrigida, não caixa: aparece como
--   o dobro exato do principal em título vencido e maior que o principal em
--   título a vencer.
--
-- CONSEQUÊNCIA DIRETA, E ELA ESTÁ CODIFICADA AQUI: esta rotina NÃO registra
-- pagamento e NÃO fala em saldo. Ela registra ALTERAÇÃO DO VALOR DO TÍTULO NA
-- FONTE (`netAmount`) entre dois ciclos, em tipos com nome literal
-- (`VALOR_FONTE_CAIU`, `VALOR_FONTE_ZEROU`, `VALOR_FONTE_SUBIU`). Nenhum deles
-- é interpretado como dinheiro recebido, e o painel diz por escrito que
-- "valor recebido" não está disponível pela fonte.
--
-- A PROVA, com variável independente, de 28/09/2026: o relatório de
-- inadimplência do próprio dia diz quem está EM ABERTO. Dos 101 títulos
-- comprovadamente em aberto e presentes no espelho, 101 tinham `paymentDate`
-- preenchido, 19 com data POSTERIOR ao vencimento, e 61 tinham `paidAmount`
-- IGUAL ao `netAmount`. Ou seja: as duas assinaturas que alguém usaria como
-- "pagou" aparecem em massa em títulos que estão abertos.
--
-- SÓ LÊ O PRIME. Nenhuma função deste arquivo escreve em tabela da cobrança,
-- dá baixa, altera acordo, caso, fila ou saldo operacional.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Abertura de ciclo. Duas execuções ao mesmo tempo não existem: a trava é por
-- carteira e é conferida no banco, não na tela.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_sinc_abrir(
  p_carteira_id uuid, p_origem text default 'manual')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id uuid; v_alvos int; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_origem not in ('cron', 'manual') then
    raise exception 'Origem inválida.' using errcode = '22023';
  end if;

  -- ciclo pendurado há mais de 30 min é encerrado como falha antes de abrir
  -- outro — senão um travamento silencioso bloquearia a carteira para sempre.
  update public.prev_sinc
     set status = 'FALHOU', concluido_em = now(),
         mensagem = coalesce(mensagem, '') || ' [encerrado por tempo]'
   where status = 'EM_ANDAMENTO' and iniciado_em < now() - interval '30 minutes';

  if exists (select 1 from public.prev_sinc
              where status = 'EM_ANDAMENTO'
                and (carteira_id = p_carteira_id or carteira_id is null)) then
    raise exception 'Já existe uma atualização em andamento para esta carteira. Espere terminar.'
      using errcode = '55006';
  end if;

  insert into public.prev_sinc (carteira_id, origem, solicitado_por)
  values (p_carteira_id, p_origem, lower(coalesce(auth.jwt() ->> 'email', 'sistema')))
  returning id into v_id;

  -- Alvos: uma consulta POR ALUNO, não por título — a API não tem rota em
  -- lote, e `GET /students/{registration}` já devolve o extrato inteiro sem
  -- paginar. Acompanha também quem saiu da janela há até 30 dias, para que
  -- pagamento logo após a saída ainda seja visto.
  insert into public.prev_sinc_fila (sinc_id, matricula)
  select distinct v_id, t.matricula_prime
    from public.prev_titulo t
   where t.carteira_id = p_carteira_id
     and (t.status = 'ATIVO' or (t.status = 'FORA_DA_JANELA' and t.saiu_em >= v_hoje - 30));
  get diagnostics v_alvos = row_count;

  update public.prev_sinc set alvos = v_alvos where id = v_id;
  return v_id;
end;
$$;

create or replace function public.preventivo_sinc_alvos(p_sinc_id uuid, p_limite int default 200)
returns setof text
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  return query
    select matricula from public.prev_sinc_fila
     where sinc_id = p_sinc_id and coletado_em is null and tentativas < 3
     order by matricula
     limit greatest(1, least(coalesce(p_limite, 200), 500));
end;
$$;

-- -----------------------------------------------------------------------------
-- Gravação de um aluno. Recebe o `financialStatement` cru do Prime, já
-- reduzido aos campos usados, e faz quatro coisas na MESMA transação:
-- resolve o vínculo do título, grava a foto, deriva o evento e atualiza o
-- estado.
--
-- COMO O TÍTULO DO ARQUIVO ENCONTRA O TÍTULO DO PRIME. O relatório de
-- inadimplência da ULBRA não traz identificador de título (medido no arquivo
-- real de 28/09/2026). Então o casamento é por `matrícula + vencimento
-- atual`, e SÓ vale quando é inequívoco:
--
--   exatamente 1 candidato  -> UNICO          (vincula e passa a usar o boleto)
--   mais de 1 candidato     -> AMBIGUO        (fica pendente; NÃO se escolhe)
--   nenhum candidato        -> NAO_ENCONTRADO (fica pendente)
--
-- Medido na amostra de 120 linhas do arquivo real contra o espelho de
-- produção: 101 alunos presentes, 101 casaram por vencimento, 5 com mais de
-- um candidato. O valor NÃO desempata — só 23 das 120 linhas tinham "Saldo
-- Original" igual ao netAmount do Prime.
--
-- p_extrato: [{documento, documento_alt, vencimento, valor_liquido,
--              valor_bruto, valor_corrigido, liquidado_em, portador,
--              portador_nome}]
--
-- UMA entrada por linha do extrato, com os dois identificadores do Prime
-- (`documento` = boleto de 7 dígitos, `documento_alt` = documentNumber de 13)
-- na MESMA entrada. Mandar a mesma linha duas vezes, uma por identificador,
-- faria cada título ter dois candidatos e marcaria a carteira inteira como
-- ambígua.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_sinc_gravar(
  p_sinc_id uuid, p_matricula text, p_extrato jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_carteira uuid;
  v_titulos  int := 0;
  v_eventos  int := 0;
  v_agora    timestamptz := now();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select carteira_id into v_carteira from public.prev_sinc where id = p_sinc_id;
  if not found then
    raise exception 'Ciclo de sincronização não encontrado.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_extrato) <> 'array' then
    -- payload fora da forma esperada NUNCA é tratado como "extrato vazio":
    -- seria concluir ausência a partir de erro técnico.
    raise exception 'Extrato do Prime veio fora da forma esperada para %.', p_matricula using errcode = '22023';
  end if;

  create temp table _prev_ext on commit drop as
  select
    nullif(trim(l->>'documento'), '')                                              as documento,
    nullif(trim(l->>'documento_alt'), '')                                          as documento_alt,
    case when (l->>'vencimento') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'vencimento')::date end as vencimento,
    case when (l->>'valor_liquido')   ~ '^-?\d+(\.\d+)?$' then (l->>'valor_liquido')::numeric end   as valor_liquido,
    case when (l->>'valor_bruto')     ~ '^-?\d+(\.\d+)?$' then (l->>'valor_bruto')::numeric end     as valor_bruto,
    case when (l->>'valor_corrigido') ~ '^-?\d+(\.\d+)?$' then (l->>'valor_corrigido')::numeric end as valor_corrigido,
    case when (l->>'liquidado_em') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'liquidado_em')::date end      as liquidado_em,
    case when (l->>'portador') ~ '^\d+$' then (l->>'portador')::int end            as portador,
    nullif(trim(l->>'portador_nome'), '')                                          as portador_nome
  from jsonb_array_elements(p_extrato) as e(l)
  where nullif(trim(l->>'documento'), '') is not null;

  -- 1. VÍNCULO, título a título. Nunca "atualiza todas as pendências do
  --    aluno": o mesmo aluno pode ter título no Preventivo e outro na
  --    cobrança, e o que acontece com um não decide nada sobre o outro.
  create temp table _prev_alvo on commit drop as
  with base as (
    select t.id, t.documento, t.documento_prime, t.vencimento,
           t.valor_fonte as antes, t.portador_atual as portador_antes,
           t.presente_no_extrato as presente_antes, t.vinculo_prime as vinculo_antes
      from public.prev_titulo t
     where t.matricula_prime = p_matricula
       and (v_carteira is null or t.carteira_id = v_carteira)
  ), resolvido as (
    select b.*,
      -- identificador que já foi resolvido antes, ou o que o arquivo trouxe
      -- identificador já resolvido antes, ou o que o arquivo trouxe; vale
      -- tanto o boleto quanto o documentNumber da mesma linha
      coalesce(
        (select e.documento from _prev_ext e
          where b.documento_prime is not null
            and (e.documento = b.documento_prime or e.documento_alt = b.documento_prime)),
        (select e.documento from _prev_ext e
          where b.documento is not null
            and (e.documento = b.documento or e.documento_alt = b.documento))
      ) as doc_direto,
      (select count(*) from _prev_ext e where e.vencimento = b.vencimento) as candidatos,
      (select min(e.documento) from _prev_ext e where e.vencimento = b.vencimento) as doc_por_vencimento
    from base b
  )
  select r.*,
    case
      when r.doc_direto is not null then r.doc_direto
      when r.candidatos = 1        then r.doc_por_vencimento
    end as doc_final,
    case
      when r.doc_direto is not null then 'UNICO'
      when r.candidatos = 1        then 'UNICO'
      when r.candidatos > 1        then 'AMBIGUO'
      else 'NAO_ENCONTRADO'
    end as vinculo
  from resolvido r;

  -- 2. FOTO. Título sem vínculo único entra na foto como ausente e SEM valor:
  --    não se copia número de um candidato que talvez não seja o certo.
  with foto as (
    insert into public.prev_titulo_snapshot (
      sinc_id, titulo_id, observado_em, presente_no_extrato, valor_fonte,
      valor_fonte_bruto, valor_fonte_corrigido, vencimento, portador, liquidado_em_prime)
    select p_sinc_id, a.id, v_agora, (a.vinculo = 'UNICO'),
           e.valor_liquido, e.valor_bruto, e.valor_corrigido, e.vencimento,
           e.portador, e.liquidado_em
      from _prev_alvo a
      left join _prev_ext e on a.vinculo = 'UNICO' and e.documento = a.doc_final
    on conflict (sinc_id, titulo_id) do nothing
    returning titulo_id
  )
  select count(*) into v_titulos from foto;

  -- 3. EVENTOS. `chave` única garante que reconsultar o Prime não duplique
  --    nada: o mesmo fato, no mesmo dia, com os mesmos valores, é um evento só.
  with classificado as (
    select a.*, e.valor_liquido as depois, e.portador as portador_depois,
      case
        when a.vinculo = 'AMBIGUO' and a.vinculo_antes is distinct from 'AMBIGUO' then 'VINCULO_AMBIGUO'
        when a.vinculo = 'UNICO'   and a.vinculo_antes is distinct from 'UNICO'
             and a.vinculo_antes <> 'PENDENTE'                                    then 'VINCULO_RESOLVIDO'
        when a.vinculo <> 'UNICO'  and a.presente_antes is true                   then 'AUSENTE_NO_EXTRATO'
        when a.vinculo = 'UNICO'   and a.presente_antes is false                  then 'RETORNO_AO_EXTRATO'
        when a.vinculo = 'UNICO' and a.antes is not null and e.valor_liquido is not null
             and e.valor_liquido < a.antes and e.valor_liquido <= 0               then 'VALOR_FONTE_ZEROU'
        when a.vinculo = 'UNICO' and a.antes is not null and e.valor_liquido is not null
             and e.valor_liquido < a.antes                                        then 'VALOR_FONTE_CAIU'
        when a.vinculo = 'UNICO' and a.antes is not null and e.valor_liquido is not null
             and e.valor_liquido > a.antes                                        then 'VALOR_FONTE_SUBIU'
        when a.vinculo = 'UNICO' and a.portador_antes is not null
             and e.portador is distinct from a.portador_antes                     then 'MUDANCA_DE_PORTADOR'
      end as tipo
      from _prev_alvo a
      left join _prev_ext e on a.vinculo = 'UNICO' and e.documento = a.doc_final
  ), gravado as (
    insert into public.prev_evento (
      titulo_id, sinc_id, tipo, valor_fonte_antes, valor_fonte_depois, valor_delta,
      observado_em, detalhe, chave)
    select c.id, p_sinc_id, c.tipo, c.antes, c.depois,
           case when c.tipo in ('VALOR_FONTE_ZEROU', 'VALOR_FONTE_CAIU', 'VALOR_FONTE_SUBIU')
                then abs(coalesce(c.antes, 0) - coalesce(c.depois, 0)) end,
           v_agora,
           jsonb_build_object('portador_antes', c.portador_antes,
                              'portador_depois', c.portador_depois,
                              'candidatos', c.candidatos,
                              'matricula', p_matricula),
           c.id::text || '|' || c.tipo || '|' || coalesce(c.antes::text, '-') || '|'
             || coalesce(c.depois::text, '-') || '|'
             || coalesce(c.portador_depois::text, '-') || '|'
             || to_char(v_agora at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
      from classificado c where c.tipo is not null
    on conflict (chave) do nothing
    returning 1
  )
  select count(*) into v_eventos from gravado;

  -- 4. ESTADO. Título sem vínculo único PRESERVA o último valor conhecido:
  --    ausência e ambiguidade não zeram nada e não são recebimento.
  update public.prev_titulo t
     set vinculo_prime      = a.vinculo,
         candidatos_prime   = a.candidatos,
         documento_prime    = coalesce(a.doc_final, t.documento_prime),
         valor_fonte           = coalesce(e.valor_liquido, t.valor_fonte),
         valor_fonte_bruto     = coalesce(e.valor_bruto, t.valor_fonte_bruto),
         valor_fonte_corrigido = coalesce(e.valor_corrigido, t.valor_fonte_corrigido),
         portador_atual     = coalesce(e.portador, t.portador_atual),
         portador_nome      = coalesce(e.portador_nome, t.portador_nome),
         presente_no_extrato = (a.vinculo = 'UNICO'),
         sinc_em            = v_agora,
         sinc_id            = p_sinc_id,
         atualizado_em      = v_agora
    from _prev_alvo a
    left join _prev_ext e on a.vinculo = 'UNICO' and e.documento = a.doc_final
   where t.id = a.id;

  update public.prev_sinc_fila
     set coletado_em = v_agora
   where sinc_id = p_sinc_id and matricula = p_matricula;

  update public.prev_sinc set consultados = consultados + 1 where id = p_sinc_id;

  drop table if exists _prev_ext;
  drop table if exists _prev_alvo;
  return jsonb_build_object('titulos', v_titulos, 'eventos', v_eventos);
end;
$$;

create or replace function public.preventivo_sinc_falhou(
  p_sinc_id uuid, p_matricula text, p_erro text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  -- Falha NÃO marca coletado e NÃO toca em saldo: o dado anterior fica de pé e
  -- a tela mostra que está desatualizado.
  update public.prev_sinc_fila
     set tentativas = tentativas + 1, ultimo_erro = left(coalesce(p_erro, 'erro'), 200)
   where sinc_id = p_sinc_id and matricula = p_matricula;
  update public.prev_sinc set erros = erros + 1 where id = p_sinc_id;
end;
$$;

create or replace function public.preventivo_sinc_concluir(p_sinc_id uuid, p_mensagem text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_pendentes int; v_status text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select count(*) into v_pendentes from public.prev_sinc_fila
   where sinc_id = p_sinc_id and coletado_em is null and tentativas < 3;

  -- Ciclo com pendência não vira "atualizado com sucesso". A tela precisa
  -- poder dizer "a última atualização COMPLETA foi em tal dia".
  select case when v_pendentes > 0 or erros > 0 then 'FALHOU' else 'CONCLUIDA' end
    into v_status from public.prev_sinc where id = p_sinc_id;

  update public.prev_sinc
     set status = v_status, concluido_em = now(),
         mensagem = coalesce(p_mensagem, mensagem)
   where id = p_sinc_id;

  perform public.preventivo_janela_aplicar();
  return jsonb_build_object('status', v_status, 'pendentes', v_pendentes);
end;
$$;

create or replace function public.preventivo_sinc_situacao(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'em_andamento', (select jsonb_build_object('id', id, 'iniciado_em', iniciado_em,
                              'alvos', alvos, 'consultados', consultados, 'erros', erros)
                       from public.prev_sinc
                      where status = 'EM_ANDAMENTO' and (carteira_id = p_carteira_id or carteira_id is null)
                      order by iniciado_em desc limit 1),
    'ultima_completa', (select jsonb_build_object('id', id, 'concluido_em', concluido_em,
                                'alvos', alvos, 'consultados', consultados)
                          from public.prev_sinc
                         where status = 'CONCLUIDA' and (carteira_id = p_carteira_id or carteira_id is null)
                         order by concluido_em desc limit 1),
    'ultima_tentativa', (select jsonb_build_object('id', id, 'status', status,
                                 'concluido_em', concluido_em, 'erros', erros, 'mensagem', mensagem)
                           from public.prev_sinc
                          where carteira_id = p_carteira_id or carteira_id is null
                          order by iniciado_em desc limit 1),
    'titulos_nunca_sincronizados', (select count(*) from public.prev_titulo
                                     where carteira_id = p_carteira_id and sinc_em is null),
    'titulos_desatualizados', (select count(*) from public.prev_titulo
                                where carteira_id = p_carteira_id
                                  and sinc_em is not null and sinc_em < now() - interval '36 hours')
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- PAINEL DE RESULTADOS
-- -----------------------------------------------------------------------------
-- DUAS GRANDEZAS DIFERENTES, E ELAS NÃO SE SOMAM:
--
--   `saldo_informado`  -> veio do ARQUIVO ("Saldo Original" do relatório de
--                         inadimplência). Ali a palavra saldo tem dono e
--                         definição: é o que a ULBRA chama de saldo em aberto
--                         na data da extração.
--   `valor_fonte`      -> veio da API (`netAmount`). É o VALOR do título, não
--                         um saldo: a API não expõe saldo em aberto nem
--                         situação. Por isso tudo que se mede sobre ele é
--                         chamado de "variação do valor na fonte" — nunca de
--                         saldo, nunca de recebimento.
--
-- `recebido` não é um número aqui. Provado em 28/09/2026 com variável
-- independente (o relatório de inadimplência do próprio dia, que diz quem
-- está EM ABERTO): dos 101 títulos comprovadamente em aberto, 101 tinham
-- paymentDate preenchido, 19 com data POSTERIOR ao vencimento, e 61 tinham
-- paidAmount IGUAL ao netAmount. Nenhum campo da API separa aberto de pago.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_resultados(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'hoje', v_hoje,
    'carteira', (select jsonb_build_object('id', id, 'nome', nome, 'venc_de', venc_de, 'venc_ate', venc_ate)
                   from public.prev_carteira where id = p_carteira_id),
    'totais', (
      select jsonb_build_object(
        'alunos',          count(distinct matricula_prime),
        'titulos',         count(*),
        'saldo_informado', coalesce(sum(saldo_informado), 0),
        'sem_sinc',        count(*) filter (where sinc_em is null),
        'na_janela',       count(*) filter (where status = 'ATIVO'),
        'fora_da_janela',  count(*) filter (where status = 'FORA_DA_JANELA')
      ) from public.prev_titulo where carteira_id = p_carteira_id),
    -- Estado do vínculo com o Prime. Sem vínculo único não há número da fonte,
    -- e a tela precisa dizer de quantos títulos ela NÃO consegue falar.
    'vinculo', (
      select coalesce(jsonb_object_agg(vinculo_prime, n), '{}'::jsonb)
        from (select vinculo_prime, count(*) n from public.prev_titulo
               where carteira_id = p_carteira_id group by 1) x),
    'valor_na_fonte', (
      select jsonb_build_object(
        'titulos_com_vinculo_unico', count(*),
        'soma_atual', coalesce(sum(valor_fonte), 0),
        'observacao', 'Soma do netAmount dos títulos com vínculo único. netAmount é o VALOR do título, não saldo em aberto — a API não expõe saldo.')
        from public.prev_titulo
       where carteira_id = p_carteira_id and vinculo_prime = 'UNICO' and valor_fonte is not null),
    -- Alteração de valor na fonte, por tipo. Nenhum destes números é dinheiro.
    'alteracoes', (
      select coalesce(jsonb_object_agg(tipo, jsonb_build_object('titulos', n, 'valor', valor)), '{}'::jsonb)
        from (select ev.tipo, count(distinct ev.titulo_id) n, coalesce(sum(ev.valor_delta), 0) valor
                from public.prev_evento ev
                join public.prev_titulo t on t.id = ev.titulo_id
               where t.carteira_id = p_carteira_id
               group by ev.tipo) m),
    'recebido', jsonb_build_object(
      'valor', null,
      'motivo', 'Não há como afirmar recebimento com a fonte autorizada de hoje. Medido em 28/09/2026 contra variável independente (o relatório de inadimplência do próprio dia): dos 101 títulos comprovadamente EM ABERTO, 101 tinham paymentDate preenchido, 19 com data posterior ao vencimento, e 61 tinham paidAmount igual ao netAmount. O financialStatement tem 13 campos e nenhum de situação, saldo ou pagamento. O que está medido abaixo é ALTERAÇÃO DE VALOR NA FONTE, que não é recebimento.'),
    'conferencia', (
      select jsonb_build_object(
        'valor_na_fonte_no_primeiro_ciclo', coalesce(sum(p.primeiro), 0),
        'queda_registrada', coalesce((select sum(valor_delta) from public.prev_evento ev
                                       join public.prev_titulo t2 on t2.id = ev.titulo_id
                                      where t2.carteira_id = p_carteira_id
                                        and ev.tipo in ('VALOR_FONTE_ZEROU', 'VALOR_FONTE_CAIU')), 0),
        'alta_registrada', coalesce((select sum(valor_delta) from public.prev_evento ev
                                      join public.prev_titulo t2 on t2.id = ev.titulo_id
                                     where t2.carteira_id = p_carteira_id
                                       and ev.tipo = 'VALOR_FONTE_SUBIU'), 0),
        'valor_na_fonte_agora', coalesce(sum(p.agora), 0))
        from (select
                (select sn.valor_fonte from public.prev_titulo_snapshot sn
                  where sn.titulo_id = t.id and sn.valor_fonte is not null
                  order by sn.observado_em limit 1) primeiro,
                t.valor_fonte agora
              from public.prev_titulo t
             where t.carteira_id = p_carteira_id and t.vinculo_prime = 'UNICO'
               and t.valor_fonte is not null) p),
    'por_dia', (
      select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'titulos', n, 'valor', valor) order by dia), '[]'::jsonb)
        from (select (ev.observado_em at time zone 'America/Sao_Paulo')::date dia,
                     count(*) n, coalesce(sum(ev.valor_delta), 0) valor
                from public.prev_evento ev
                join public.prev_titulo t on t.id = ev.titulo_id
               where t.carteira_id = p_carteira_id
                 and ev.tipo in ('VALOR_FONTE_ZEROU', 'VALOR_FONTE_CAIU')
               group by 1) d),
    'alunos', (
      select jsonb_build_object(
        'com_alguma_queda', count(*) filter (where caiu > 0 and caiu < titulos),
        'com_todos_zerados', count(*) filter (where zerados = titulos and titulos > 0),
        'sem_alteracao',    count(*) filter (where caiu = 0))
        from (select t.matricula_prime, count(*) titulos,
                     count(*) filter (where exists (select 1 from public.prev_evento ev
                                                     where ev.titulo_id = t.id
                                                       and ev.tipo in ('VALOR_FONTE_ZEROU','VALOR_FONTE_CAIU'))) caiu,
                     count(*) filter (where t.valor_fonte is not null and t.valor_fonte <= 0) zerados
                from public.prev_titulo t where t.carteira_id = p_carteira_id
               group by 1) a)
  ) into v;
  return v;
end;
$$;

create or replace function public.preventivo_titulos(
  p_carteira_id uuid,
  p_lote_id uuid default null,
  p_status text default null,
  p_venc_de date default null,
  p_venc_ate date default null,
  p_faixa_atraso text default null,
  p_movimento text default null,
  p_vinculo text default null,
  p_limite int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(x order by x->>'vencimento'), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'id', t.id, 'aluno', t.aluno_nome, 'matricula', t.matricula_prime,
      'documento', coalesce(t.documento_prime, t.documento),
      'competencia', t.competencia, 'unidade', t.unidade,
      'vencimento', t.vencimento, 'vencimento_origem', t.vencimento_origem,
      'dias_atraso', (v_hoje - t.vencimento),
      'saldo_informado', t.saldo_informado,
      'valor_fonte', t.valor_fonte,
      'vinculo', t.vinculo_prime, 'candidatos', t.candidatos_prime,
      'situacao_origem', t.situacao_origem, 'status', t.status,
      'portador', t.portador_atual, 'portador_nome', t.portador_nome,
      'sinc_em', t.sinc_em, 'celular', t.celular_aluno, 'email', t.email_aluno,
      'lote', (select l.nome from public.prev_lote l where l.id = t.lote_origem_id),
      'ultima_alteracao', (select jsonb_build_object('tipo', ev.tipo, 'em', ev.observado_em, 'valor', ev.valor_delta)
                             from public.prev_evento ev where ev.titulo_id = t.id
                            order by ev.observado_em desc limit 1),
      'ultima_acao', (select jsonb_build_object('nome', a.nome, 'canal', a.canal, 'estado', a.estado,
                                                'em', coalesce(a.envio_confirmado_em, a.exportada_em, a.criada_em))
                        from public.prev_acao_destinatario d
                        join public.prev_acao a on a.id = d.acao_id
                       where d.titulo_id = t.id and d.incluido
                       order by coalesce(a.envio_confirmado_em, a.exportada_em, a.criada_em) desc limit 1)
    ) x
    from public.prev_titulo t
    where t.carteira_id = p_carteira_id
      and (p_lote_id is null or exists (select 1 from public.prev_titulo_lote tl
                                         where tl.titulo_id = t.id and tl.lote_id = p_lote_id))
      and (p_status is null or t.status = p_status)
      and (p_vinculo is null or t.vinculo_prime = p_vinculo)
      and (p_venc_de is null or t.vencimento >= p_venc_de)
      and (p_venc_ate is null or t.vencimento <= p_venc_ate)
      and (p_faixa_atraso is null or (
            case
              when p_faixa_atraso = 'a_vencer'  then (v_hoje - t.vencimento) < 0
              when p_faixa_atraso = '0_5'       then (v_hoje - t.vencimento) between 0 and 5
              when p_faixa_atraso = '6_15'      then (v_hoje - t.vencimento) between 6 and 15
              when p_faixa_atraso = '16_31'     then (v_hoje - t.vencimento) between 16 and 31
              when p_faixa_atraso = 'acima_31'  then (v_hoje - t.vencimento) > 31
              else true end))
      and (p_movimento is null or (
            case
              when p_movimento = 'caiu'    then exists (select 1 from public.prev_evento ev
                                                         where ev.titulo_id = t.id
                                                           and ev.tipo in ('VALOR_FONTE_ZEROU','VALOR_FONTE_CAIU'))
              when p_movimento = 'zerado'  then t.valor_fonte is not null and t.valor_fonte <= 0
              when p_movimento = 'sem_alteracao' then not exists (select 1 from public.prev_evento ev
                                                         where ev.titulo_id = t.id
                                                           and ev.tipo in ('VALOR_FONTE_ZEROU','VALOR_FONTE_CAIU'))
              else true end))
    limit greatest(1, least(coalesce(p_limite, 500), 5000))
  ) q;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- AÇÕES E EXPORTAÇÃO
-- -----------------------------------------------------------------------------
-- Elegibilidade do Preventivo, escrita aqui e em lugar nenhum mais. NÃO reusa
-- bloqueio da cobrança: "bloqueado" lá quer dizer coisas (acordo em vigor,
-- caso em jurídico, fidelização) que não se traduzem no preventivo.
create or replace function public.preventivo_acao_preparar(
  p_carteira_id uuid, p_nome text, p_canal text, p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_acao uuid; v_sinc uuid; v_sinc_em timestamptz; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Dê um nome à ação.' using errcode = '22023';
  end if;

  select id, concluido_em into v_sinc, v_sinc_em from public.prev_sinc
   where status = 'CONCLUIDA' and (carteira_id = p_carteira_id or carteira_id is null)
   order by concluido_em desc limit 1;

  insert into public.prev_acao (carteira_id, nome, canal, filtros, sinc_referencia_id,
                                sinc_referencia_em, criada_por)
  values (p_carteira_id, trim(p_nome), p_canal, coalesce(p_filtros, '{}'::jsonb),
          v_sinc, v_sinc_em, lower(coalesce(auth.jwt() ->> 'email', 'sistema')))
  returning id into v_acao;

  -- Um destinatário por TÍTULO elegível, e um contato por aluno no público.
  insert into public.prev_acao_destinatario (acao_id, titulo_id, matricula, aluno_nome, contato, incluido, motivo)
  select v_acao, t.id, t.matricula_prime, t.aluno_nome,
         case when p_canal = 'WHATSAPP' then t.celular_aluno else t.email_aluno end,
         false, null
    from public.prev_titulo t
   where t.carteira_id = p_carteira_id
     and (p_filtros->>'lote_id' is null
          or exists (select 1 from public.prev_titulo_lote tl
                      where tl.titulo_id = t.id and tl.lote_id = (p_filtros->>'lote_id')::uuid))
     and (p_filtros->>'venc_de' is null  or t.vencimento >= (p_filtros->>'venc_de')::date)
     and (p_filtros->>'venc_ate' is null or t.vencimento <= (p_filtros->>'venc_ate')::date);

  -- motivo de exclusão, na ordem de leitura da gestão
  update public.prev_acao_destinatario d
     set motivo = m.motivo, incluido = (m.motivo is null)
    from (
      select d2.id,
        case
          when t.status <> 'ATIVO'                      then 'FORA_DA_JANELA_PREVENTIVA'
          when (v_hoje - t.vencimento) > public.preventivo_limite_dias() then 'FORA_DA_JANELA_PREVENTIVA'
          -- Só sai do público o que tem PROVA de que não deve ser cobrado.
          -- Vínculo pendente ou ambíguo NÃO exclui ninguém: ele é mostrado no
          -- resumo da ação, porque a alternativa (bloquear) deixaria a frente
          -- parada enquanto o acesso de pagamento não existir, e o arquivo da
          -- gestão já é a fonte que diz quem está inadimplente.
          when t.valor_fonte is not null and t.valor_fonte <= 0 then 'VALOR_NA_FONTE_ZERADO'
          when upper(coalesce(t.situacao_origem, '')) like '%CANCEL%' then 'SITUACAO_CANCELADA_NA_ORIGEM'
          when p_canal = 'WHATSAPP' and t.celulares_no_arquivo > 1 then 'CELULAR_AMBIGUO_NO_ARQUIVO'
          when p_canal = 'WHATSAPP' and t.celular_aluno is null then 'SEM_CELULAR_VALIDO'
          when p_canal = 'EMAIL'    and t.emails_no_arquivo > 1
               and coalesce((p_filtros->>'usar_primeiro_email')::boolean, false) is not true
                                                                then 'EMAIL_MULTIPLO_NO_ARQUIVO'
          when p_canal = 'EMAIL'    and t.email_aluno is null
               and coalesce((p_filtros->>'usar_primeiro_email')::boolean, false) is not true
                                                                then 'SEM_EMAIL_VALIDO'
          when p_canal = 'EMAIL'    and t.email_aluno is null
               and coalesce(t.emails_no_arquivo, 0) = 0         then 'SEM_EMAIL_VALIDO'
        end as motivo
      from public.prev_acao_destinatario d2
      join public.prev_titulo t on t.id = d2.titulo_id
     where d2.acao_id = v_acao) m
   where d.id = m.id;

  -- Um celular por aluno no público: se o mesmo número aparece para alunos
  -- DIFERENTES, nenhum dos dois entra por padrão — personalizar mensagem para
  -- a pessoa errada é pior do que não mandar.
  update public.prev_acao_destinatario d
     set incluido = false, motivo = 'CONTATO_COMPARTILHADO_COM_OUTRO_ALUNO'
   where d.acao_id = v_acao and d.incluido and d.contato is not null
     and exists (select 1 from public.prev_acao_destinatario o
                  where o.acao_id = v_acao and o.incluido and o.contato = d.contato
                    and o.matricula <> d.matricula);

  -- Um envio por aluno: entre os títulos elegíveis do mesmo aluno, o de
  -- vencimento mais antigo representa a pessoa. Os demais ficam registrados na
  -- ação (com motivo) para o consolidado não somar o mesmo aluno duas vezes.
  update public.prev_acao_destinatario d
     set incluido = false, motivo = 'OUTRO_TITULO_DO_MESMO_ALUNO_JA_NO_PUBLICO'
    from (select d2.id,
                 row_number() over (partition by d2.matricula
                                    order by t.vencimento, t.documento) rn
            from public.prev_acao_destinatario d2
            join public.prev_titulo t on t.id = d2.titulo_id
           where d2.acao_id = v_acao and d2.incluido) r
   where d.id = r.id and r.rn > 1;

  return public.preventivo_acao_resumo(v_acao);
end;
$$;

create or replace function public.preventivo_acao_resumo(p_acao_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', a.id, 'nome', a.nome, 'canal', a.canal, 'estado', a.estado,
    'filtros', a.filtros, 'criada_em', a.criada_em, 'criada_por', a.criada_por,
    'exportada_em', a.exportada_em, 'envio_confirmado_em', a.envio_confirmado_em,
    'cancelada_em', a.cancelada_em,
    'atualizacao_financeira', jsonb_build_object('sinc_id', a.sinc_referencia_id, 'em', a.sinc_referencia_em),
    'incluidos', (select count(*) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'alunos', (select count(distinct d.matricula) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'separados', (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                    from (select motivo, count(*) n from public.prev_acao_destinatario
                           where acao_id = a.id and not incluido and motivo is not null group by 1) s),
    -- CONFERÊNCIA FINANCEIRA DO PÚBLICO. Não bloqueia, mas não deixa a lista
    -- passar por conferida: diz de quantos destinatários o Prime conseguiu
    -- falar e de quantos não.
    'conferencia_financeira', (
      select coalesce(jsonb_object_agg(vinculo_prime, n), '{}'::jsonb)
        from (select t.vinculo_prime, count(*) n
                from public.prev_acao_destinatario d
                join public.prev_titulo t on t.id = d.titulo_id
               where d.acao_id = a.id and d.incluido group by 1) c)
  ) into v from public.prev_acao a where a.id = p_acao_id;
  return v;
end;
$$;

create or replace function public.preventivo_acao_publico(p_acao_id uuid, p_incluidos boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'matricula', d.matricula, 'aluno', d.aluno_nome, 'contato', d.contato,
    'documento', t.documento, 'vencimento', t.vencimento,
    'saldo_informado', t.saldo_informado, 'valor_fonte', t.valor_fonte,
    'incluido', d.incluido, 'motivo', d.motivo) order by d.aluno_nome), '[]'::jsonb)
    into v
    from public.prev_acao_destinatario d
    join public.prev_titulo t on t.id = d.titulo_id
   where d.acao_id = p_acao_id and d.incluido = p_incluidos;
  return v;
end;
$$;

create or replace function public.preventivo_acao_marcar(p_acao_id uuid, p_estado text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_atual text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select estado into v_atual from public.prev_acao where id = p_acao_id;
  if not found then raise exception 'Ação não encontrada.' using errcode = '22023'; end if;

  -- EXPORTAR NÃO É ENVIAR: só a gestão marca "envio confirmado", e só depois
  -- de exportar. Nada aqui dispara mensagem.
  if p_estado = 'EXPORTADA' and v_atual <> 'PREPARADA' then
    raise exception 'Só uma ação preparada pode ser marcada como exportada.' using errcode = '22023';
  end if;
  if p_estado = 'ENVIO_CONFIRMADO' and v_atual <> 'EXPORTADA' then
    raise exception 'Confirme o envio só depois de exportar o arquivo para a mensageria.' using errcode = '22023';
  end if;
  if p_estado not in ('EXPORTADA', 'ENVIO_CONFIRMADO', 'CANCELADA') then
    raise exception 'Estado inválido.' using errcode = '22023';
  end if;

  update public.prev_acao
     set estado = p_estado,
         exportada_em        = case when p_estado = 'EXPORTADA' then now() else exportada_em end,
         envio_confirmado_em = case when p_estado = 'ENVIO_CONFIRMADO' then now() else envio_confirmado_em end,
         cancelada_em        = case when p_estado = 'CANCELADA' then now() else cancelada_em end
   where id = p_acao_id;
  return public.preventivo_acao_resumo(p_acao_id);
end;
$$;

create or replace function public.preventivo_acoes(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(x order by x->>'criada_em' desc), '[]'::jsonb) into v from (
    select public.preventivo_acao_resumo(a.id)
           -- movimento POSTERIOR ao envio confirmado. Cada título entra uma vez
           -- por ação; no consolidado da carteira o mesmo pagamento nunca é
           -- somado duas vezes porque a soma é feita por título, não por ação.
           || jsonb_build_object('movimento_apos_envio', (
                select jsonb_build_object(
                  'titulos', count(distinct ev.titulo_id),
                  'valor', coalesce(sum(ev.valor_delta), 0))
                  from public.prev_evento ev
                  join public.prev_acao_destinatario d
                    on d.titulo_id = ev.titulo_id and d.acao_id = a.id and d.incluido
                 where a.envio_confirmado_em is not null
                   and ev.observado_em > a.envio_confirmado_em
                   and ev.tipo in ('VALOR_FONTE_ZEROU', 'VALOR_FONTE_CAIU'))) as x
      from public.prev_acao a where a.carteira_id = p_carteira_id
  ) q;
  return v;
end;
$$;

comment on function public.preventivo_acoes(uuid) is
  'Resultado por ação. `movimento_apos_envio` é QUEDA DO VALOR NA FONTE depois do envio confirmado — não é pagamento e não prova que o envio causou coisa alguma. A tela diz isso com todas as letras.';

do $$
declare f text;
begin
  foreach f in array array[
    'preventivo_sinc_abrir(uuid, text)',
    'preventivo_sinc_alvos(uuid, integer)',
    'preventivo_sinc_gravar(uuid, text, jsonb)',
    'preventivo_sinc_falhou(uuid, text, text)',
    'preventivo_sinc_concluir(uuid, text)',
    'preventivo_sinc_situacao(uuid)',
    'preventivo_resultados(uuid)',
    'preventivo_titulos(uuid, uuid, text, date, date, text, text, text, integer)',
    'preventivo_acao_preparar(uuid, text, text, jsonb)',
    'preventivo_acao_resumo(uuid)',
    'preventivo_acao_publico(uuid, boolean)',
    'preventivo_acao_marcar(uuid, text)',
    'preventivo_acoes(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end
$$;
