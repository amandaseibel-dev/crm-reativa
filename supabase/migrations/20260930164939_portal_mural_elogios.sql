-- B — Mural de elogios da equipe.
--
-- NAO cria tabela de elogios. A fonte e public.elogios_atendimento, que ja existe
-- e tem o fluxo completo do CRM (print obrigatorio, analise, publicacao na TV).
--
-- O PROBLEMA A RESOLVER: a policy `elogios_select` restringe a leitura a quem
-- registrou, a quem foi elogiado e a pode_gerir_elogios_tv(). Um mural coletivo
-- precisa que TODA a equipe leia os elogios publicados -- e afrouxar aquela
-- policy exporia os rejeitados, os prints, as observacoes internas e as
-- tratativas da gestao. Entao a policy fica INTOCADA e a leitura do mural sai
-- por uma funcao SECURITY DEFINER que devolve 4 campos e mais nada.
--
-- O QUE O MURAL DEVOLVE            O QUE NUNCA SAI DAQUI
--   id (para poder curtir)           print_path, print_nome_arquivo
--   texto_final_tv                   observacao_operador
--   operador_nome                    motivo_rejeicao
--   publicado_em                     analisado_por_*, publicado_por_email
--                                    arquivado_*, registrado_por_*
--                                    operador_email, aluno_id, movimentacao_id
--                                    status, exibir_de, exibir_ate
--
-- SO `PUBLICADO_TV` E SO COM TEXTO APROVADO: dos 5 elogios PUBLICADO_TV em
-- producao hoje, apenas 1 tem texto_final_tv. Nos outros 4 o elogio esta apenas
-- no print. O mural exige texto aprovado nao-vazio e NUNCA cai para
-- observacao_operador, que e texto interno do operador e nao passou por curadoria.
-- Encher os outros 4 e trabalho editorial da gestao, nao tecnico.
--
-- A JANELA exibir_de/exibir_ate NAO e aplicada: ela governa o rodizio da TV, e os
-- 5 publicados tem janela de agosto/setembro ja vencida -- aplicar deixaria o
-- mural vazio para sempre. Mural e parede de reconhecimento, nao slideshow.

-- 1. Curtidas passam a aceitar elogio.
--    Um ALTER do CHECK, como previsto no A2: nenhuma migracao de dado, nenhum
--    indice recriado, a chave de unicidade ja inclui alvo_tipo.
alter table public.portal_curtidas
  drop constraint if exists portal_curtidas_alvo_tipo_check;
alter table public.portal_curtidas
  add constraint portal_curtidas_alvo_tipo_check
  check (alvo_tipo in ('playlist', 'elogio'));

-- 2. Contagem TOTAL de curtidas por alvo (nao semanal).
--
--    A musica da semana e uma disputa semanal; elogio e reconhecimento que
--    acumula. Por isso esta funcao existe ao lado de portal_curtidas_da_semana,
--    em vez de no lugar dela.
create or replace function public.portal_curtidas_totais(p_alvo_tipo text)
returns table (alvo_id uuid, curtidas integer, eu_curti boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select k.alvo_id,
         count(*)::int,
         bool_or(lower(k.usuario_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
    from public.portal_curtidas k
   where k.alvo_tipo = p_alvo_tipo
   group by k.alvo_id;
$$;

comment on function public.portal_curtidas_totais(text) is
  'Por alvo: total de curtidas (todas as semanas) e se a pessoa logada ja curtiu. Para elogios e ideias, onde o reconhecimento acumula -- a versao semanal e portal_curtidas_da_semana.';

-- 3. O mural.
--
--    SECURITY DEFINER porque precisa ler elogios_atendimento por cima de
--    `elogios_select` SEM afrouxar aquela policy. Em troca, a funcao e a parte
--    estreita do funil: filtro fixo, colunas fixas, nenhum parametro que permita
--    pedir outra coisa.
--
--    O portao de quem pode chamar e app_usuario_ativo(): usuario do app, ativo.
--    Sessao valida de conta desativada nao le o mural.
create or replace function public.portal_mural_elogios(p_limite integer default 12)
returns table (
  id uuid,
  texto text,
  operador_nome text,
  publicado_em timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id,
         btrim(e.texto_final_tv),
         e.operador_nome,
         e.publicado_em
    from public.elogios_atendimento e
   where public.app_usuario_ativo()
     and e.status = 'PUBLICADO_TV'
     and nullif(btrim(e.texto_final_tv), '') is not null
   order by e.publicado_em desc nulls last, e.id
   limit greatest(1, least(coalesce(p_limite, 12), 50));
$$;

comment on function public.portal_mural_elogios(integer) is
  'Mural coletivo: elogios PUBLICADO_TV com texto aprovado nao-vazio, apenas id/texto/operador/data. SECURITY DEFINER para nao afrouxar elogios_select -- print, observacao interna, motivo de rejeicao, e-mails e status NUNCA saem por aqui.';

revoke execute on function public.portal_curtidas_totais(text) from anon;
revoke execute on function public.portal_mural_elogios(integer) from anon, public;
grant execute on function public.portal_curtidas_totais(text) to authenticated;
grant execute on function public.portal_mural_elogios(integer) to authenticated;
