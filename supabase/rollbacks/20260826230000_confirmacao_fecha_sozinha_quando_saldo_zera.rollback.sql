-- Rollback: a confirmação volta a exigir um segundo clique.
--
-- ATENÇÃO: isso devolve o retrabalho. Quem baixa já é quem tem autoridade para
-- decidir (Amanda, Fernanda, Amanda ADM); sem o gatilho, o aluno que ficou sem
-- saldo continua preso na fila esperando alguém confirmar o que já foi provado.
-- Eram 76 nessa situação em 26/08/2026.
drop trigger if exists trg_fechar_confirmacao_parcela on public.parcelas;
drop trigger if exists trg_fechar_confirmacao_titulo on public.acordos_titulos;
drop function if exists public._fechar_confirmacao_ao_zerar_saldo();
