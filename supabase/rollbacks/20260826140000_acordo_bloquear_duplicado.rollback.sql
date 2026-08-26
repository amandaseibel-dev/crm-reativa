-- Rollback: libera de novo o lancamento duplicado.
--
-- So faca isso se a trava estiver barrando caso legitimo -- e, antes, confira o
-- que ela recusou: a mensagem de erro sempre diz qual acordo ja existia. Sem a
-- trava, a duplicacao volta pelo cadastro manual, que foi por onde entraram 88
-- dos 104 duplicados ativos.

drop trigger if exists trg_acordo_bloquear_duplicado on public.acordos;
drop function if exists public.tg_acordo_bloquear_duplicado();
