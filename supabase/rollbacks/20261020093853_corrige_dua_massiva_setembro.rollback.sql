-- ROLLBACK de 20261020093853_corrige_dua_massiva_setembro.
--
-- Devolve `data_ultimo_acionamento` ao valor que estava antes da correcao,
-- lendo a trilha por id EXATO -- sem PITR, backup + reversao por id e o unico
-- rollback possivel (ver docs e o backup de 05/10).
--
-- SO REVERTE O QUE A CORRECAO ESCREVEU: a condicao
-- `a.data_ultimo_acionamento = b.dua_depois` garante que, se o aluno foi
-- acionado DEPOIS da correcao, o acionamento novo fica -- nao se apaga contato
-- real para desfazer um ajuste de campo.
--
-- LIMITE CONHECIDO, declarado em vez de escondido: dos 11, UM
-- (2031900f-d2d2-4949-9119-e6b0a09e66f3) tinha o campo NULO. O gatilho
-- `trg_acionamento_nao_volta_para_nulo` restaura o valor antigo quando o novo e
-- nulo ("acionamento e fato consumado, uma vez registrado nao se apaga"), entao
-- esse aluno NAO volta a nulo por SQL -- o UPDATE reporta a linha e o campo
-- volta sozinho na mesma transacao. E o mesmo comportamento ja documentado em
-- 05/10 para `status_acionamento`. Os outros 10 revertem normalmente.
-- Desligar esse gatilho mexeria numa protecao que vale para todo o CRM e NAO
-- esta neste rollback.

-- alunos: so onde o valor atual ainda e exatamente o que a correcao gravou
update public.alunos a
   set data_ultimo_acionamento = b.dua_antes
  from public._backup_dua_massiva_setembro_20261020 b
 where a.id = b.aluno_id
   and a.data_ultimo_acionamento = b.dua_depois;

-- casos: mesma regra EXATA do aluno -- so reverte o caso que ainda esta com o
-- valor que a correcao escreveu (o dia da massiva, em Brasilia). Caso que
-- andou depois, por acionamento real, fica como esta.
update public.casos c
   set data_ultimo_acionamento = bc.dua_antes
  from public._backup_dua_massiva_setembro_20261020_casos bc
  join public._backup_dua_massiva_setembro_20261020 ba on ba.aluno_id = bc.aluno_id
 where c.id = bc.caso_id
   and c.data_ultimo_acionamento = (ba.dua_depois at time zone 'America/Sao_Paulo')::date;

-- A funcao sai; as tabelas de trilha FICAM (sao o registro de auditoria do que
-- foi feito em 20/10, e o unico lugar onde o estado anterior existe).
drop function if exists public._corrige_dua_massiva_setembro(uuid[]);
