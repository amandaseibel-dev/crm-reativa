-- Só Amanda, Fernanda e Amanda ADM lançam acordo.
--
-- Amanda, 26/08/2026: "lembrete só eu e a fernanda e amanda podemos lançar
-- esses acordos".
--
-- ONDE ESTAVA O FURO: a regra existia só na TELA. A ficha do aluno esconde o
-- "Montar novo acordo" de quem não pode baixar, mas o RLS embaixo aceitava
-- INSERT de qualquer operador ativo, desde que o aluno fosse dele. Ou seja:
-- a regra valia enquanto a pessoa usasse o botão.
--
-- Na prática ninguém passou por fora -- os 298 acordos feitos na mão saíram
-- exatamente desses três e-mails, e os outros 3.232 vieram da importação
-- (service_role, que a função libera). Então esta trava não muda o trabalho
-- de ninguém: ela só faz o banco dizer o mesmo que a tela já dizia.
--
-- Reusa crm_usuario_pode_quitar_baixar(), que já é a lista dessas três pessoas
-- e é a mesma porta de quitar e baixar. Uma lista só, num lugar só: mudou de
-- gente, muda ali e vale para tudo.

drop policy if exists acordos_insert on public.acordos;

create policy acordos_insert on public.acordos
for insert
with check (
  not eh_painel()
  and app_usuario_ativo()
  and crm_usuario_pode_quitar_baixar()
);

comment on policy acordos_insert on public.acordos is
  'Lancamento de acordo restrito a gestao financeira (crm_usuario_pode_quitar_baixar): Amanda, Fernanda e Amanda ADM, mais a importacao via service_role. Antes o RLS aceitava qualquer operador ativo -- a regra vivia so na tela.';
