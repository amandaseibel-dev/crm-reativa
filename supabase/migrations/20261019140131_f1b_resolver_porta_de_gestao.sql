-- F1.b: PORTA DE GESTAO para o resolver de vinculo de pagamento (somente leitura).
--
-- PARA QUE: a analise F1.b precisa saber QUAIS pagamentos pertencem a cada confirmacao.
-- Isso ja existe em public.confirmacao_pagamentos_resolver(uuid), que resolve por duas
-- rotas (VINCULO_GRAVADO e CHAVE_MESMA_TRANSACAO) e cobre 251 das 274 confirmacoes
-- abertas -- contra 35 quando o navegador le solicitacao_confirmacao_pagamentos direto.
-- Faltava apenas o navegador poder chamar.
--
-- POR QUE UM ENVELOPE, E NAO UM PORTAO DENTRO DO RESOLVER:
--   1. public.confirmacao_pagamento_processado(uuid) (SECURITY DEFINER) CHAMA o resolver
--      por dentro. usuario_e_gestao() e `auth.jwt()->>'email' in (<3 emails>)`, que da
--      FALSE para service_role, postgres e cron -- nao ha JWT ali. Um portao incondicional
--      dentro do resolver quebraria esse caminho interno que hoje funciona.
--   2. A migration 20260922100150 revogou EXECUTE de public/anon/authenticated nessas
--      funcoes DE PROPOSITO ("menor privilegio: nenhuma e chamada pelo front"). Abrir o
--      resolver reverteria aquela decisao. O envelope a PRESERVA: o resolver segue
--      revogado para authenticated; so o envelope e chamavel, e so com portao.
--
-- O QUE ESTA MIGRATION FAZ: cria UMA funcao nova. Nao altera, nao substitui e nao
-- reconcede nada do que ja existe.
--
-- PROVA DE QUE O RESOLVER NAO FOI TOCADO: corpo em producao em 19/10/2026 tem 3801 bytes,
-- md5(prosrc) = f9ed8548789684bd2ebe20e0894e8f89, identico ao do arquivo
-- 20260922100100_confirmacao_processada_resolver.sql. Esta migration nao emite
-- CREATE OR REPLACE para ele, entao esse md5 deve continuar o mesmo depois de aplicar.
--
-- SEM EFEITO FINANCEIRO: STABLE, nenhum INSERT/UPDATE/DELETE, nenhuma baixa, nenhuma
-- quitacao, nenhuma mudanca de status, saldo ou fila. Devolve as mesmas linhas do
-- resolver, para quem a RLS de gestao ja autoriza.
--
-- ROLLBACK (nao precisa de PITR, que nao esta habilitado):
--   drop function if exists public.confirmacao_pagamentos_resolver_gestao(uuid);
-- Nada mais a restaurar: nenhum objeto preexistente e modificado aqui.
begin;

create or replace function public.confirmacao_pagamentos_resolver_gestao(p_confirmacao_id uuid)
 returns table(pagamento_id uuid, prova text, motivo text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  -- V-PORTAO: o envelope existe POR CAUSA desta linha. Sem ela nao ha motivo para
  -- abrir EXECUTE a authenticated, porque o retorno e prova financeira por aluno.
  if not public.usuario_e_gestao() then
    raise exception 'somente a gestao pode resolver o vinculo de pagamento da confirmacao'
      using errcode = '42501';
  end if;
  return query
    select r.pagamento_id, r.prova, r.motivo
      from public.confirmacao_pagamentos_resolver(p_confirmacao_id) r;
end;
$function$;

comment on function public.confirmacao_pagamentos_resolver_gestao(uuid) is
  'Envelope de leitura do resolver de vinculo de pagamento, com portao usuario_e_gestao(). Criado para a analise F1.b no navegador. Nao escreve, nao baixa, nao quita. O resolver interno segue sem EXECUTE para authenticated (20260922100150).';

-- Funcao nova HERDA EXECUTE para public/anon/authenticated pelo default do Postgres.
-- Revogar primeiro e conceder so a authenticated: o portao interno faz o resto.
revoke all on function public.confirmacao_pagamentos_resolver_gestao(uuid) from public, anon;
grant execute on function public.confirmacao_pagamentos_resolver_gestao(uuid) to authenticated;
grant execute on function public.confirmacao_pagamentos_resolver_gestao(uuid) to service_role;

commit;
