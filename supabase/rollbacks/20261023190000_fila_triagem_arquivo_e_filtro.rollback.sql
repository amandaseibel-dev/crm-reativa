-- Rollback de 20261023190000_fila_triagem_arquivo_e_filtro
--
-- NAO FOI EXECUTADO.
--
-- Devolve `fila_pagamento_triagem_ler` a assinatura de 2 argumentos e ao corpo
-- EXATO que estava em producao antes da migration -- o texto abaixo e copia do
-- `pg_get_functiondef` lido em 2026-10-23, sem uma linha nossa a mais.
--
-- NADA A RESTAURAR DE DADO. A migration nao escreveu em tabela alguma: so
-- trocou uma funcao de leitura. Nao ha backup a repor, e por isso este arquivo
-- nao tem bloco "ESTADO ANTES" -- o estado anterior e o proprio corpo da funcao.
--
-- A TELA NAO QUEBRA COM ESTE ROLLBACK. `PagamentosSemAluno` trata a ausencia da
-- funcao e o erro de assinatura pelo mesmo caminho defensivo que ja existia
-- antes (a faixa diz "Triagem ainda nao publicada no banco." e a lista
-- principal segue inteira). Depois do rollback, a chamada com
-- `p_importacao_id` passa a falhar; a faixa desaparece e a fila continua --
-- nunca o contrario. O link vindo da conferencia "Por arquivo" deixa de
-- recortar, mas a fila abre completa.

drop function if exists public.fila_pagamento_triagem_ler(text, integer, uuid);

CREATE OR REPLACE FUNCTION public.fila_pagamento_triagem_ler(p_categoria text DEFAULT NULL::text, p_limite integer DEFAULT 1000)
 RETURNS TABLE(pagamento_id uuid, aluno_id uuid, data_pagamento date, valor_pago numeric, status_conciliacao text, titulo_numero text, boleto text, categoria text, subcategoria text, etapa_desligada text, acao_sugerida text, motivo text, sugestoes jsonb, decisao text, decidido_por text, decidido_em timestamp with time zone, toques_na_linha integer, primeira_tentativa_em timestamp with time zone, consulta_portador_em timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         t.toques_na_linha, t.primeira_tentativa_em, t.consulta_portador_em
    from public.vw_fila_pagamento_triagem t
   where p_categoria is null or t.categoria = p_categoria
   -- Maior valor primeiro dentro da categoria: quem confere comeca pelo que
   -- pesa. `pagamento_id` como desempate e so estabilidade de ordem -- NAO e
   -- criterio de prioridade, e nao deve ser lido como tal.
   order by t.categoria, t.valor_pago desc nulls last, t.pagamento_id
   limit greatest(coalesce(p_limite, 1000), 1);
end
$function$;

revoke all on function public.fila_pagamento_triagem_ler(text, integer) from public;

grant execute on function public.fila_pagamento_triagem_ler(text, integer) to authenticated;
grant execute on function public.fila_pagamento_triagem_ler(text, integer) to service_role;
