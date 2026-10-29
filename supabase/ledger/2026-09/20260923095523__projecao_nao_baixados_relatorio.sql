-- RELATORIO "NAO BAIXADOS / REJEITADOS" DA PROJECAO -- SOMENTE LEITURA.
--
-- A PERGUNTA QUE ELE RESPONDE, sem sair da Projecao:
--   o pagamento entrou -> foi baixado?  se nao -> por que?  ja analisado -> qual foi a decisao?
--
-- NENHUM FLUXO NOVO DE CONCILIACAO. Le o que ja existe e ja e escrito por
-- outra gente: `pagamentos.status_conciliacao` (motor da conciliacao,
-- 20260914140000), `fila_pagamento_sem_vinculo` (fila manual, com FEITO e
-- REJEITADO de 20260923020000), `parcelas`, `acordos`, `alunos`, `importacoes`.
-- Nao cria tabela, nao duplica a fila, nao escreve linha nenhuma.
--
-- A PROVA DE QUE E SO LEITURA E DO POSTGRES, NAO DO COMENTARIO: a funcao e
-- declarada STABLE. Uma funcao nao-VOLATILE que tente INSERT/UPDATE/DELETE
-- falha em tempo de execucao com "is not allowed in a non-volatile function".
-- Abrir a tela nao baixa, nao devolve baixa, nao reprocessa e nao mexe na fila.
--
-- QUEM ENTRA NO UNIVERSO. Somente pagamento cuja importacao e
-- `importacoes.tipo = 'PROJECAO_DIARIA'` -- o mesmo caminho que alimenta a
-- Projecao (`projecao_importar_pagamentos`). Os 714 pagamentos de julho/2026
-- sem `importacao_id` e o unico de tipo SANTANDER ficam de fora por desenho:
-- nao vieram da Projecao.
--
-- A REGRA CRITICA, "nao baixado + motivo vazio nao existe", E DO BANCO.
-- `motivo_categoria` e `motivo_texto` sao NOT NULL por construcao: quando o
-- motivo nao pode ser determinado -- linha importada antes de 14/09/2026, que
-- e quando a conciliacao passou a registrar o desfecho -- a categoria e
-- `MOTIVO_NAO_CLASSIFICADO` e o texto diz exatamente isso. Nunca NULL, nunca
-- string vazia. Medido em 23/09/2026: dos 60 nao baixados COM estado, 60 tem
-- motivo proprio; os 8.241 anteriores a 14/09 nao tem, e e por isso que eles
-- so aparecem quando a gestao pede (`incluir_sem_estado`).
--
-- O CORTE DE 14/09/2026 E REAL, nao estimado: medido por dia de importacao,
-- 100% das linhas importadas de 14/09 em diante tem `status_conciliacao`, e
-- praticamente nenhuma antes (so 44 que o reprocessamento alcancou).

-- === A FUNCAO ==============================================================
--
-- Filtros, todos opcionais, em um unico jsonb (`p_filtros`):
--   pagamento_de / pagamento_ate ....... date, periodo do pagamento
--   importacao_de / importacao_ate ..... date, periodo da importacao na Projecao
--   termo .............................. texto livre: nome, matricula, CPF ou boleto
--   matricula / boleto ................. exatos
--   valor_min / valor_max .............. numeric
--   status_conciliacao ................. text[]  (AGUARDANDO_ACORDO, PARCELA_JA_PAGA, ...)
--   motivo ............................. text[]  categorias de motivo_categoria
--   resultado .......................... text[]  PENDENTE / FEITO / REJEITADO / ...
--   saldo .............................. 'COM' | 'ZERO'
--   situacao_parcela ................... text[]  PAGA / VENCIDA / A_VENCER / CANCELADA / SEM_PARCELA
--   incluir_sem_estado ................. bool, traz os anteriores a 14/09/2026
--   incluir_baixados ................... bool, historico completo (inclusive o que baixou certo)
--   ordem .............................. 'VALOR_DESC' (padrao) | 'ANTIGO_PRIMEIRO'
--   limite ............................. int, teto de LINHAS devolvidas (padrao 2000, max 20000)
--
-- Os CONTADORES e a visao POR ALUNO sao calculados sobre o conjunto filtrado
-- INTEIRO, antes do teto -- o teto corta a lista, nunca a conta.

create or replace function public.projecao_nao_baixados(p_filtros jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_res jsonb;
  v_limite int := least(greatest(coalesce((p_filtros->>'limite')::int, 2000), 1), 20000);
  v_ordem  text := coalesce(nullif(p_filtros->>'ordem',''), 'VALOR_DESC');
  v_sem_estado bool := coalesce((p_filtros->>'incluir_sem_estado')::bool, false);
  v_baixados   bool := coalesce((p_filtros->>'incluir_baixados')::bool, false);
  v_termo text := nullif(btrim(coalesce(p_filtros->>'termo','')), '');
  v_termo_num text := regexp_replace(coalesce(p_filtros->>'termo',''), '\D', '', 'g');
begin
  -- MESMO PORTAO DA FILA DE PAGAMENTOS (`pagamentos_sem_aluno`): o relatorio
  -- expoe CPF, saldo e decisao nominal. EXECUTE continua com `authenticated`
  -- porque no Supabase todo usuario logado chama a API como `authenticated`;
  -- revogar isso derrubaria a tela para a propria gestao.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'O relatorio de nao baixados da Projecao e da gestao financeira.'
      using errcode = '42501';
  end if;

  with base as (
    select
      p.id                                   as pagamento_id,
      p.data_pagamento,
      i.created_at                           as importado_em,
      i.arquivo_nome,
      p.aluno_id,
      p.aluno_nome,
      p.matricula,
      p.cpf,
      p.numero_parcela_completo              as boleto,
      p.titulo_numero,
      p.valor_pago,
      p.valor_honorario,
      p.operador_nome,
      p.status_conciliacao,
      nullif(btrim(coalesce(p.conciliacao_motivo,'')),'') as conciliacao_motivo,
      ltrim(coalesce(p.numero_parcela_completo,''),'0')   as chave
    from public.pagamentos p
    join public.importacoes i
      on i.id = p.importacao_id
     and i.tipo = 'PROJECAO_DIARIA'
  ),
  -- `parcelas.boleto` e unico (13.553 boletos, 13.553 distintos em 23/09/2026)
  -- e `fila_pagamento_sem_vinculo.pagamento_id` tambem (187/187): nenhum dos
  -- dois joins multiplica linha.
  lig as (
    select
      b.*,
      pa.id           as parcela_id,
      pa.numero       as parcela_numero,
      pa.status       as parcela_status,
      pa.vencimento   as parcela_vencimento,
      ac.numero_ulbra as acordo_numero,
      ac.status       as acordo_status,
      f.decisao,
      nullif(btrim(coalesce(f.motivo,'')),'') as fila_motivo,
      f.conclusao,
      f.motivo_rejeicao,
      f.observacao,
      f.decidido_por,
      f.decidido_em,
      f.detectado_em,
      f.primeira_tentativa_em,
      f.ultima_tentativa_em,
      coalesce(f.quantidade_tentativas, 0) as quantidade_tentativas,
      (f.pagamento_id is not null)          as na_fila,
      al.saldo_total,
      al.saldo_vencido,
      al.cpf_mascarado
    from base b
    left join public.parcelas pa on pa.boleto = nullif(b.chave,'')
    left join public.acordos   ac on ac.id = pa.acordo_id
    left join public.fila_pagamento_sem_vinculo f on f.pagamento_id = b.pagamento_id
    left join public.alunos    al on al.id = b.aluno_id
  ),
  class as (
    select
      l.*,
      -- SITUACAO ATUAL DA PARCELA, lida agora -- nao no dia da importacao.
      case
        when l.parcela_id is null                            then 'SEM_PARCELA'
        when upper(coalesce(l.parcela_status,'')) = 'PAGO'   then 'PAGA'
        when upper(coalesce(l.parcela_status,'')) = 'CANCELADA' then 'CANCELADA'
        when l.parcela_vencimento < (now() at time zone 'America/Sao_Paulo')::date then 'VENCIDA'
        else 'A_VENCER'
      end as situacao_parcela,
      -- STATUS DA BAIXA. Tres estados, porque "nao baixou" e "nao ha registro
      -- de baixa" sao coisas diferentes e misturar as duas inventaria prova.
      case
        when l.status_conciliacao = 'BAIXADO'    then 'BAIXADO'
        when l.status_conciliacao is not null    then 'NAO_BAIXADO'
        else 'NAO_REGISTRADO'
      end as status_baixa,
      -- RESULTADO DA ANALISE. O vocabulario e o da coluna `decisao` da fila;
      -- PENDENTE e a ausencia de decisao, que e como TODAS as 19 funcoes que
      -- leem essa coluna definem "pendente".
      case
        when l.decisao is not null                                    then l.decisao
        when l.na_fila                                                then 'PENDENTE'
        when l.status_conciliacao = 'BAIXADO'                         then 'BAIXADO_SEM_PENDENCIA'
        when l.status_conciliacao is not null                         then 'PENDENTE'
        else 'SEM_ANALISE'
      end as resultado_analise,
      case
        when l.decisao is not null then 'DECIDIDA'
        when l.na_fila             then 'ABERTA'
        else 'FORA_DA_FILA'
      end as status_fila
    from lig l
  ),
  motivada as (
    select
      c.*,
      -- ------------------------------------------------------------------
      -- MOTIVO -- NUNCA NULO, NUNCA VAZIO. A regra critica mora aqui.
      -- ------------------------------------------------------------------
      case
        when c.status_baixa = 'BAIXADO' and c.situacao_parcela = 'PAGA' then 'SEM_PENDENCIA'
        when c.status_baixa = 'BAIXADO'                                 then 'BAIXA_DESFEITA_DEPOIS'
        when c.status_conciliacao is not null                           then c.status_conciliacao
        else 'MOTIVO_NAO_CLASSIFICADO'
      end as motivo_categoria,
      coalesce(
        c.conciliacao_motivo,
        c.fila_motivo,
        case
          when c.status_baixa = 'BAIXADO' and c.situacao_parcela = 'PAGA'
            then 'a parcela do boleto foi baixada nesta importacao e segue PAGO'
          when c.status_baixa = 'BAIXADO'
            then 'a baixa foi registrada nesta importacao, mas a parcela do boleto nao esta mais PAGO: conferir estorno ou reabertura posterior'
          when c.situacao_parcela = 'SEM_PARCELA'
            then 'importado antes de 14/09/2026, quando a conciliacao passou a registrar o desfecho: nao ha motivo gravado, e o boleto nao existe em parcelas'
          when c.situacao_parcela = 'PAGA'
            then 'importado antes de 14/09/2026, quando a conciliacao passou a registrar o desfecho: a parcela do boleto consta PAGO hoje, mas nao ha registro de qual pagamento a baixou'
          else 'importado antes de 14/09/2026, quando a conciliacao passou a registrar o desfecho: nao ha motivo gravado, e a parcela do boleto segue '
               || coalesce(nullif(c.parcela_status,''), 'em aberto')
        end
      ) as motivo_texto
    from class c
  ),
  filtrada as (
    select m.* from motivada m
    where
      -- POPULACAO. Por padrao so o que NAO baixou e tem estado registrado.
      -- Baixa desfeita depois entra sempre: e pendencia, nao historico.
      (
        (m.status_baixa = 'NAO_BAIXADO')
        or (m.motivo_categoria = 'BAIXA_DESFEITA_DEPOIS')
        or (v_sem_estado and m.status_baixa = 'NAO_REGISTRADO' and m.situacao_parcela <> 'PAGA')
        or v_baixados
      )
      and (p_filtros->>'pagamento_de'  is null or m.data_pagamento >= (p_filtros->>'pagamento_de')::date)
      and (p_filtros->>'pagamento_ate' is null or m.data_pagamento <= (p_filtros->>'pagamento_ate')::date)
      and (p_filtros->>'importacao_de'  is null or m.importado_em >= (p_filtros->>'importacao_de')::date)
      and (p_filtros->>'importacao_ate' is null or m.importado_em < ((p_filtros->>'importacao_ate')::date + 1))
      and (p_filtros->>'valor_min' is null or m.valor_pago >= (p_filtros->>'valor_min')::numeric)
      and (p_filtros->>'valor_max' is null or m.valor_pago <= (p_filtros->>'valor_max')::numeric)
      and (p_filtros->>'matricula' is null or m.matricula = p_filtros->>'matricula')
      and (p_filtros->>'boleto' is null
           or m.boleto = p_filtros->>'boleto'
           or m.chave  = ltrim(p_filtros->>'boleto','0'))
      -- `position` e nao `like`: o termo vem digitado, e um `%` ou `_` no meio
      -- de um nome viraria curinga sem ninguem pedir.
      and (v_termo is null
           or position(upper(v_termo) in upper(coalesce(m.aluno_nome,''))) > 0
           or position(v_termo in coalesce(m.matricula,'')) > 0
           or position(v_termo in coalesce(m.boleto,'')) > 0
           or position(v_termo in coalesce(m.titulo_numero,'')) > 0
           or (v_termo_num <> ''
               and position(v_termo_num in regexp_replace(coalesce(m.cpf,''), '\D', '', 'g')) > 0))
      and (p_filtros->'status_conciliacao' is null
           or jsonb_array_length(p_filtros->'status_conciliacao') = 0
           or m.status_conciliacao = any (select jsonb_array_elements_text(p_filtros->'status_conciliacao')))
      and (p_filtros->'motivo' is null
           or jsonb_array_length(p_filtros->'motivo') = 0
           or m.motivo_categoria = any (select jsonb_array_elements_text(p_filtros->'motivo')))
      and (p_filtros->'resultado' is null
           or jsonb_array_length(p_filtros->'resultado') = 0
           or m.resultado_analise = any (select jsonb_array_elements_text(p_filtros->'resultado')))
      and (p_filtros->'situacao_parcela' is null
           or jsonb_array_length(p_filtros->'situacao_parcela') = 0
           or m.situacao_parcela = any (select jsonb_array_elements_text(p_filtros->'situacao_parcela')))
      and (p_filtros->>'saldo' is null
           or (p_filtros->>'saldo' = 'COM'  and coalesce(m.saldo_total,0) > 0)
           or (p_filtros->>'saldo' = 'ZERO' and coalesce(m.saldo_total,0) = 0))
  ),
  ordenada as (
    select f.*,
           row_number() over (
             order by
               case when v_ordem = 'ANTIGO_PRIMEIRO' then f.data_pagamento end asc,
               case when v_ordem = 'ANTIGO_PRIMEIRO' then null else f.valor_pago end desc,
               f.data_pagamento desc,
               f.pagamento_id
           ) as ord
      from filtrada f
  ),
  contadores as (
    select jsonb_build_object(
      'linhas',                count(*),
      'valor_total',           coalesce(sum(valor_pago), 0),
      'valor_honorario',       coalesce(sum(valor_honorario), 0),
      'nao_baixados',          count(*) filter (where status_baixa <> 'BAIXADO'),
      'valor_nao_baixado',     coalesce(sum(valor_pago) filter (where status_baixa <> 'BAIXADO'), 0),
      'pendentes',             count(*) filter (where resultado_analise = 'PENDENTE'),
      'valor_pendente',        coalesce(sum(valor_pago) filter (where resultado_analise = 'PENDENTE'), 0),
      'feito',                 count(*) filter (where resultado_analise = 'FEITO'),
      'valor_feito',           coalesce(sum(valor_pago) filter (where resultado_analise = 'FEITO'), 0),
      'rejeitado',             count(*) filter (where resultado_analise = 'REJEITADO'),
      'valor_rejeitado',       coalesce(sum(valor_pago) filter (where resultado_analise = 'REJEITADO'), 0),
      'encerrado_gestao',      count(*) filter (where resultado_analise = 'ENCERRADO_GESTAO'),
      'resolvido_automatico',  count(*) filter (where resultado_analise = 'RESOLVIDO_AUTOMATICO'),
      'sem_analise',           count(*) filter (where resultado_analise = 'SEM_ANALISE'),
      'sem_estrutura',         count(*) filter (where status_conciliacao = 'ACORDO_CONFIRMADO_SEM_ESTRUTURA'),
      'aguardando_acordo',     count(*) filter (where status_conciliacao = 'AGUARDANDO_ACORDO'),
      'parcela_ja_paga',       count(*) filter (where status_conciliacao = 'PARCELA_JA_PAGA'),
      'revisao',               count(*) filter (where status_conciliacao = 'REVISAO'),
      'sem_motivo',            count(*) filter (where coalesce(btrim(motivo_texto),'') = ''),
      'alunos_unicos',         count(distinct coalesce(aluno_id::text, 'SEM_ALUNO:' || coalesce(aluno_nome,'?')))
    ) j from filtrada
  ),
  por_aluno as (
    select jsonb_agg(x order by x_valor desc) j from (
      select
        jsonb_build_object(
          'aluno_id',            max(aluno_id::text),
          'aluno_nome',          max(aluno_nome),
          'matricula',           max(matricula),
          'cpf_mascarado',       max(cpf_mascarado),
          'qtd',                 count(*),
          'valor_total',         coalesce(sum(valor_pago), 0),
          'qtd_nao_baixado',     count(*) filter (where status_baixa <> 'BAIXADO'),
          'qtd_pendente',        count(*) filter (where resultado_analise = 'PENDENTE'),
          'qtd_feito',           count(*) filter (where resultado_analise = 'FEITO'),
          'qtd_rejeitado',       count(*) filter (where resultado_analise = 'REJEITADO'),
          'saldo_total',         max(saldo_total),
          'saldo_vencido',       max(saldo_vencido),
          'pagamento_mais_antigo', min(data_pagamento),
          'ultimo_pagamento',      max(data_pagamento),
          -- PRINCIPAL MOTIVO = o mais frequente do aluno; empate desempata
          -- pelo nome da categoria, para a lista nao dancar entre chamadas.
          'principal_motivo',    mode() within group (order by motivo_categoria)
        ) as x,
        coalesce(sum(valor_pago), 0) as x_valor
      from filtrada
      group by coalesce(aluno_id::text, 'SEM_ALUNO:' || coalesce(aluno_nome,'?'))
      order by 2 desc
      limit 5000
    ) t
  ),
  linhas as (
    select jsonb_agg(to_jsonb(o) - 'ord' - 'chave' - 'cpf' - 'na_fila'
                            - 'conciliacao_motivo' - 'fila_motivo' order by o.ord) j
      from (select * from ordenada where ord <= v_limite) o
  )
  select jsonb_build_object(
    'gerado_em',  now(),
    'filtros',    p_filtros,
    'limite',     v_limite,
    'truncado',   (select (c.j->>'linhas')::int > v_limite from contadores c),
    'contadores', (select j from contadores),
    'por_aluno',  coalesce((select j from por_aluno), '[]'::jsonb),
    'linhas',     coalesce((select j from linhas), '[]'::jsonb)
  ) into v_res;

  return v_res;
end;
$fn$;

comment on function public.projecao_nao_baixados(jsonb) is
  'Relatorio SOMENTE LEITURA dos pagamentos da PROJECAO_DIARIA que nao viraram baixa, com o motivo e a decisao ja registrados em pagamentos.status_conciliacao e fila_pagamento_sem_vinculo. STABLE: o Postgres recusa qualquer escrita aqui dentro. Nao cria fluxo de conciliacao, nao duplica a fila, nao reprocessa nada.';

revoke all on function public.projecao_nao_baixados(jsonb) from public, anon;
grant execute on function public.projecao_nao_baixados(jsonb) to authenticated, service_role;

-- === PROVAS ================================================================
do $prova$
declare v_src text; v_vol char;
begin
  select prosrc, provolatile into v_src, v_vol
    from pg_proc where oid = 'public.projecao_nao_baixados(jsonb)'::regprocedure;

  if v_vol <> 's' then
    raise exception 'PROVA: projecao_nao_baixados precisa ser STABLE -- e a garantia de leitura';
  end if;

  if v_src !~* 'usuario_e_gestao' then
    raise exception 'PROVA: projecao_nao_baixados perdeu o portao da gestao';
  end if;

  if v_src ~* '\m(insert|update|delete|truncate)\M\s+(into|from|public\.|set)' then
    raise exception 'PROVA: projecao_nao_baixados tem comando de escrita';
  end if;

  if v_src !~ 'MOTIVO_NAO_CLASSIFICADO' then
    raise exception 'PROVA: projecao_nao_baixados perdeu o estado explicito de motivo nao determinado';
  end if;

  if has_function_privilege('anon', 'public.projecao_nao_baixados(jsonb)', 'EXECUTE') then
    raise exception 'PROVA: anon nao pode executar o relatorio';
  end if;
end
$prova$;
