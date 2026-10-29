-- Fila da triagem: de que ARQUIVO veio a pendencia, e filtro por importacao.
--
-- SOMENTE LEITURA. Nenhuma tabela criada ou alterada, nenhum gatilho, nenhum
-- cron, nenhum DML. Nao toca pagamentos, baixas, acordos nem saldos.
--
-- ---------------------------------------------------------------------------
-- O QUE ISTO RESOLVE
-- ---------------------------------------------------------------------------
--
-- A Central de Pagamentos ganhou a conferencia "Por arquivo" (20261023164204),
-- e ela ja identifica as divergencias de cada importacao. Medido em PROD em
-- 2026-10-23: nas tres categorias que pedem gente -- DIVERGENCIA (74),
-- SEM_VINCULO (22) e BAIXA_PENDENTE (357) -- TODAS as 453 linhas ja tem
-- pendencia em `fila_pagamento_sem_vinculo`, a fila oficial. ZERO itens de
-- fora. Ou seja: nao falta fila, e nao ha nada para migrar.
--
-- O que faltava era o caminho de volta. Quem abre a conferencia de um arquivo
-- e ve uma divergencia nao tinha como ir a fila recortada naquele arquivo, e
-- quem abre a fila nao via de que arquivo cada pendencia veio -- embora o dado
-- esteja gravado: `fila_pagamento_sem_vinculo.importacao_id` e `.arquivo_nome`
-- existem e estao preenchidos nas 420 pendencias abertas (420/420).
--
-- POR QUE A VIEW NAO FOI REESCRITA. A gestao aprovou "expor importacao_id e
-- arquivo_nome na vw_fila_pagamento_triagem". Fazer isso exige `create or
-- replace view` reproduzindo os 5.044 caracteres da definicao atual a mao, e
-- carregar as duas colunas por tres niveis de CTE (`base` -> `classificado` ->
-- select final). O risco nao e teorico: a classificacao da #737 vive nesse
-- corpo, e um erro de transcricao a mudaria em silencio. Este projeto ja pagou
-- exatamente essa conta (ver a licao registrada em
-- `create-or-replace-exige-ler-a-funcao-inteira`).
--
-- A funcao leitora tem 2.012 caracteres, ja e o unico consumidor da view e ja
-- e o portao da tela. Entao as duas colunas entram AQUI, por um join 1:1 na
-- mesma tabela que a view ja le -- `fila_pagamento_sem_vinculo` tem
-- `UNIQUE (pagamento_id)`, portanto o join nao multiplica linha. O resultado
-- para a tela e identico ao aprovado, com um quinto do texto reescrito.
-- Se a gestao quiser a view canonica carregando as colunas tambem, isso fica
-- como passo proprio, com o diff da view revisado linha a linha.
--
-- POR QUE `drop` E DEPOIS `create`, e nao so `create or replace`. A assinatura
-- muda (ganha `p_importacao_id`). `create or replace` com lista de argumentos
-- diferente NAO substitui: cria uma SEGUNDA funcao. As duas passariam a existir
-- e a chamada por argumento nomeado da tela (`p_categoria`, `p_limite`) ficaria
-- AMBIGUA entre elas. Por isso a antiga sai primeiro.
--
-- A tela atual continua funcionando sem deploy novo: ela chama com
-- `p_categoria` e `p_limite`, e `p_importacao_id` tem default null.

-- ---------------------------------------------------------------------------
-- 1) Fora a assinatura de 2 argumentos
-- ---------------------------------------------------------------------------
drop function if exists public.fila_pagamento_triagem_ler(text, integer);

-- ---------------------------------------------------------------------------
-- 2) A mesma leitura, com a origem do arquivo e o filtro por importacao
-- ---------------------------------------------------------------------------
create or replace function public.fila_pagamento_triagem_ler(
  p_categoria     text    default null,
  p_limite        integer default 1000,
  p_importacao_id uuid    default null
)
returns table (
  pagamento_id          uuid,
  aluno_id              uuid,
  data_pagamento        date,
  valor_pago            numeric,
  status_conciliacao    text,
  titulo_numero         text,
  boleto                text,
  categoria             text,
  subcategoria          text,
  etapa_desligada       text,
  acao_sugerida         text,
  motivo                text,
  sugestoes             jsonb,
  decisao               text,
  decidido_por          text,
  decidido_em           timestamp with time zone,
  toques_na_linha       integer,
  primeira_tentativa_em timestamp with time zone,
  consulta_portador_em  timestamp with time zone,
  -- As duas novas vao no FIM de proposito: quem le por nome nao muda, e a
  -- tela que ainda nao conhece as colunas simplesmente as ignora.
  importacao_id         uuid,
  arquivo_nome          text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- MESMO PORTAO de `pagamentos_sem_aluno` e `pagamentos_trava`, com a recusa
  -- explicita de identidade nula. `coalesce(..., false)`: sem isto, um token sem
  -- claim de e-mail faria `usuario_e_gestao()` devolver NULL, o `not NULL` seria
  -- NULL -- que nao e TRUE -- e o `if` nao dispararia.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A triagem da fila de pagamentos e da gestao financeira.'
      using errcode = '42501';
  end if;

  return query
  select t.pagamento_id, t.aluno_id, t.data_pagamento, t.valor_pago,
         t.status_conciliacao, t.titulo_numero, t.boleto,
         t.categoria, t.subcategoria, t.etapa_desligada, t.acao_sugerida,
         t.motivo, t.sugestoes, t.decisao, t.decidido_por, t.decidido_em,
         t.toques_na_linha, t.primeira_tentativa_em, t.consulta_portador_em,
         f.importacao_id, f.arquivo_nome
    from public.vw_fila_pagamento_triagem t
    -- 1:1 garantido por `fila_pag_sem_vinculo_unico UNIQUE (pagamento_id)`.
    -- `left join` porque a triagem tambem classifica pagamento que ainda nao
    -- tem linha de fila: nesse caso as duas colunas vem nulas, e a linha
    -- continua aparecendo -- a fila nunca encolhe por falta do dado novo.
    left join public.fila_pagamento_sem_vinculo f on f.pagamento_id = t.pagamento_id
   -- OS DOIS PARENTESES SAO OBRIGATORIOS. Sem eles, `A or B and C` liga como
   -- `A or (B and C)`: com `p_categoria` nulo a condicao inteira viraria TRUE e
   -- o filtro por arquivo seria ignorado em silencio.
   where (p_categoria is null or t.categoria = p_categoria)
     and (p_importacao_id is null or f.importacao_id = p_importacao_id)
   -- Maior valor primeiro dentro da categoria: quem confere comeca pelo que
   -- pesa. `pagamento_id` como desempate e so estabilidade de ordem -- NAO e
   -- criterio de prioridade, e nao deve ser lido como tal.
   order by t.categoria, t.valor_pago desc nulls last, t.pagamento_id
   limit greatest(coalesce(p_limite, 1000), 1);
end
$function$;

comment on function public.fila_pagamento_triagem_ler(text, integer, uuid) is
  'Triagem da fila de pagamentos para a gestao financeira. Acrescenta, em '
  '23/10/2026, a origem do arquivo (importacao_id, arquivo_nome, lidas de '
  'fila_pagamento_sem_vinculo por join 1:1) e o filtro p_importacao_id, que '
  'liga a conferencia "Por arquivo" a esta fila sem criar fila nova.';

-- ---------------------------------------------------------------------------
-- 3) Grants -- o `drop` levou os antigos; estes repoem exatamente os que havia
-- ---------------------------------------------------------------------------
revoke all on function public.fila_pagamento_triagem_ler(text, integer, uuid) from public;

grant execute on function public.fila_pagamento_triagem_ler(text, integer, uuid) to authenticated;
grant execute on function public.fila_pagamento_triagem_ler(text, integer, uuid) to service_role;
