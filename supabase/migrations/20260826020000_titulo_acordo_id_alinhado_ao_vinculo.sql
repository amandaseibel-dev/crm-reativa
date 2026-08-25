-- Título vinculado precisa carregar o `acordo_id` do vínculo.
--
-- Medido em prod 2026-08-25. Sobra de 23--27/07, anterior ao reparo de
-- 25/08 (20260825230000) -- não é reincidência daquele defeito.
--
-- O estado: 169 títulos / 53 alunos / R$ 645.983,18 com
--   situacao = 'NEGOCIADO', status = 'vinculada',
--   linha existente e válida em `acordo_titulo_vinculo`,
--   mas `acordos_titulos.acordo_id` NULO.
--
-- Não dobra dívida -- como a situação é NEGOCIADO, o título já fica fora do
-- saldo em aberto (a `vw_saude_carteira` exige situacao='ABERTO'). O prejuízo é
-- de rastreabilidade: `acordo_id` é a coluna que as telas e consultas usam para
-- ir do título ao acordo, e para esses 169 ela mente por omissão. Quem junta
-- título e acordo por `acordo_id` simplesmente não os vê.
--
-- `acordo_titulo_vinculo` é a fonte da verdade; `acordo_id` é a cópia
-- desnormalizada. Este reparo alinha a cópia à fonte -- não cria vínculo nenhum.
--
-- Conferência de ambiguidade feita ANTES (o cuidado que definiu o reparo de
-- 25/08 vale aqui também -- não vincular por semelhança):
--   169 títulos alvo · 169 com acordo ÚNICO · 0 ambíguos ·
--   0 apontando para acordo inexistente · 0 com acordo fora do status ATIVO.
-- Ou seja: cada título mapeia para exatamente um acordo ativo. Zero decisão.
--
-- Triggers conferidas antes de aplicar:
--   trg_auto_quitar_titulo          -- só dispara em UPDATE OF situacao; aqui a
--                                      situação não muda, então não dispara.
--   trg_titulo_normaliza_vinculo_incoerente -- só age quando situacao='ABERTO';
--                                      o alvo é NEGOCIADO, então não interfere.
--   trg_audit                       -- registra a alteração, que é o desejado.
--
-- Rollback: supabase/rollbacks/20260826020000_titulo_acordo_id_alinhado_ao_vinculo.rollback.sql

-- Marca o reparo antes de alterar, para que o rollback saiba exatamente quais
-- linhas tocar. `motivo_ajuste` já existe e é o campo de anotação do título.
update public.acordos_titulos t
   set acordo_id = v.acordo_id,
       motivo_ajuste = coalesce(nullif(t.motivo_ajuste, ''), '') ||
                       case when coalesce(t.motivo_ajuste, '') = '' then '' else ' | ' end ||
                       'acordo_id alinhado ao vinculo em 2026-08-26 (reparo_acordo_id_20260826)'
  from public.acordo_titulo_vinculo v
 where v.titulo_id = t.id
   and coalesce(v.ativo, true)
   and t.acordo_id is null
   and t.situacao = 'NEGOCIADO'
   and t.status = 'vinculada'
   -- só onde não há dúvida: um único acordo para o título
   and (select count(distinct v2.acordo_id)
          from public.acordo_titulo_vinculo v2
         where v2.titulo_id = t.id and coalesce(v2.ativo, true)) = 1
   -- e o acordo precisa existir e estar ativo
   and exists (select 1 from public.acordos ac where ac.id = v.acordo_id and ac.status = 'ATIVO');

-- Conferência pós-reparo: deve sobrar ZERO no estado corrigido.
do $$
declare v_restante integer;
begin
  select count(*) into v_restante
    from public.acordos_titulos t
   where t.situacao = 'NEGOCIADO' and t.status = 'vinculada' and t.acordo_id is null
     and exists (select 1 from public.acordo_titulo_vinculo v
                  where v.titulo_id = t.id and coalesce(v.ativo, true));
  raise notice 'Titulos vinculados ainda sem acordo_id: %', v_restante;
end $$;
