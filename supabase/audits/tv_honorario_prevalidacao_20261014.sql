-- =============================================================================
-- PRÉ-VALIDAÇÃO da migration 20261014113000 — SOMENTE LEITURA
-- -----------------------------------------------------------------------------
-- Para rodar em produção ANTES de aplicar a migration, quando o projeto Supabase
-- estiver disponível. Responde a uma única pergunta:
--
--     as quatro âncoras do patch casam com o corpo VIVO de tv_snapshot_calcular()?
--
-- POR QUE ISSO É A ÚNICA COISA QUE FALTA CONFERIR. O resto já está provado fora
-- de produção, em Postgres descartável, por
-- `supabase/tests/tv_honorario_indicador_principal.test.js`: o patch aplica, o
-- plpgsql compila, o payload sai certo, aplicar duas vezes é inofensivo e o
-- rollback volta atrás. Aquele teste monta a função a partir do TEXTO
-- VERSIONADO (20260811220000). O que nenhum teste local alcança é o corpo que
-- está realmente instalado em produção, que recebeu patches ancorados de outras
-- frentes depois daquela data. É isso que este arquivo mede.
--
-- O QUE ELE NÃO FAZ, por construção:
--   • não cria, altera ou remove função, tabela, política ou dado;
--   • não roda tv_snapshot_calcular() nem tv_snapshot_atualizar();
--   • não grava snapshot, não toca em pagamentos, acordos, títulos ou metas;
--   • não precisa de service_role: `pg_get_functiondef` basta.
-- É um SELECT. Pode rodar com a TV no ar, a qualquer hora.
--
-- COMO LER O RESULTADO. Uma linha por âncora, com `ocorrencias` e `veredito`:
--
--   OK — ancora unica, patch pode ser aplicado   → as 4 assim: segue a aplicação
--   JA APLICADO (nada a fazer)                   → o patch já está em produção
--   AUSENTE - corpo vivo divergiu                → PARE. O corpo mudou; a âncora
--                                                  precisa ser refeita a partir
--                                                  do texto vivo antes de aplicar
--   AMBIGUA (n ocorrencias) - PARE               → idem; replace atingiria mais
--                                                  de um ponto
--
-- Se qualquer linha não for OK ou JA APLICADO, não aplique. A migration aborta
-- sozinha nesse caso (cada bloco exige ocorrência única), então nada quebraria
-- em silêncio — mas é melhor descobrir aqui do que no log da aplicação.
--
-- A última linha do resultado é um resumo: `PRONTO PARA APLICAR` ou `NAO APLICAR`.
-- =============================================================================

with vivo as (
  select pg_get_functiondef(p.oid) as src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular'
   limit 1
),
-- As quatro âncoras, em cópia. Texto literal de propósito: este arquivo tem de
-- poder ser colado num SQL editor sozinho, sem o repositório à mão. Cópia
-- defasada daria "AUSENTE" num banco saudável e pararia a aplicação sem motivo,
-- então ela é EXERCITADA: o teste
-- `supabase/tests/tv_honorario_indicador_principal.test.js` roda esta consulta
-- contra a função antes de aplicar (espera 3x OK), depois de aplicar (espera 3x
-- JA APLICADO) e contra um corpo deliberadamente divergente (espera AUSENTE +
-- NAO APLICAR). Se a migration mudar e esta cópia não, o teste quebra.
ancoras(ordem, nome, de, marca_aplicado) as (
  values
    (1, 'maior_pagamento_dia',
     $a$  select jsonb_build_object('valor', round(valor_pago)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia from public.pagamentos where data_pagamento = current_date and lower(operador_email) = any(v_ops) order by valor_pago desc nulls last limit 1;$a$,
     $b$'honorario', round(valor_honorario)::bigint,
           'operador', coalesce(nullif(operador_nome,''), operador_email, '-'))
    into v_maior_dia$b$),

    (2, 'v_rankings',
     $a$    'melhor_dia', (select jsonb_build_object('operador', op) from ($a$,
     $b$'melhor_dia', (select jsonb_build_object('operador', op, 'honorario', h)$b$),

    (3, 'media_diaria_honorarios',
     $a$    'media_diaria', v_media_dia, 'projecao_fechamento', v_proj_fech,$a$,
     $b$'media_diaria_honorarios'$b$),

    -- A 4a ancora tem OUTRA PROCEDENCIA: este trecho nao esta em 20260811220000,
    -- foi inserido no corpo vivo por 20261006110000. Se aquela migration nao
    -- estiver aplicada neste banco, o indicador da semana nem existe e a linha
    -- sai como 'AUSENTE' -- nesse caso especifico NAO e impedimento: o bloco 4
    -- da migration reconhece a situacao e nao faz nada (a tela cai no fallback
    -- por quantidade, como antes daquela migration). Confira com:
    --   select position('ranking_semana_valor' in pg_get_functiondef(p.oid)) > 0
    --     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    --    where n.nspname='public' and p.proname='tv_snapshot_calcular';
    (4, 'ranking_semana_valor',
     $a$      from (select op_norm op, round(sum(valor_pago)) vl from unif where data_pagamento >= date_trunc('week', v_hoje)::date and lower(operador_email) = any(v_ops) group by op_norm order by sum(valor_pago) desc limit 8) r),$a$,
     $b$round(sum(valor_honorario)) vl from unif$b$)
),
medido as (
  select a.ordem, a.nome,
         (length(v.src) - length(replace(v.src, a.de, ''))) / length(a.de) as ocorrencias,
         position(a.marca_aplicado in v.src) > 0                           as ja_aplicado
    from ancoras a cross join vivo v
),
veredito as (
  select ordem, nome, ocorrencias, ja_aplicado,
         case when ja_aplicado      then 'JA APLICADO (nada a fazer)'
              when ocorrencias = 1  then 'OK - ancora unica, patch pode ser aplicado'
              when ocorrencias = 0  then 'AUSENTE - corpo vivo divergiu: refazer a ancora antes de aplicar'
              else 'AMBIGUA (' || ocorrencias || ' ocorrencias) - PARE'
         end as veredito
    from medido
)
select ordem::text as ordem, nome, ocorrencias::text as ocorrencias, veredito from veredito
union all
select 'resumo', '—', '—',
       case when count(*) filter (where veredito like 'OK%' or veredito like 'JA APLICADO%') = 4
            then 'PRONTO PARA APLICAR'
            else 'NAO APLICAR - ver as linhas acima' end
  from veredito
order by ordem;

-- -----------------------------------------------------------------------------
-- OPCIONAL, também somente leitura: a fotografia que a TV está exibindo AGORA.
-- Útil para comparar os números antes e depois da aplicação. Lê a tabela de
-- snapshot já gravada — não chama a função, não regenera nada.
-- -----------------------------------------------------------------------------
-- select dia, recuperado_mes, honorarios_mes, proj_recuperado, proj_honorarios, atualizado_em
--   from public.tv_projecao_snapshot order by dia desc limit 5;
