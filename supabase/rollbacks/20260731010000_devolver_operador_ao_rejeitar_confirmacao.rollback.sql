-- ROLLBACK: DEVOLVER OPERADOR AO REJEITAR CONFIRMAÇÃO
begin;
drop trigger if exists trg_devolver_operador_ao_rejeitar on public.solicitacoes_confirmacao_pagamento;
drop function if exists public.devolver_operador_ao_rejeitar_confirmacao();
drop table if exists public.calibragem_dono_anterior_confirmacao;
commit;
