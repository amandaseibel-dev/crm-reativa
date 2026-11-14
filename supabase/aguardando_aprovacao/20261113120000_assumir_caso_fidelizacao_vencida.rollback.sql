-- ROLLBACK de 20261113120000_assumir_caso_fidelizacao_vencida.
--
-- Remove as duas RPCs. NAO apaga a tabela public.assumir_fidelizacao_operacoes
-- (historico de auditoria: nunca apagar linhas). NAO desfaz tomadas ja feitas:
-- para desfazer uma tomada, usar reverter_assumir_fidelizacao(operacao_id) ANTES
-- deste rollback, ou tratar caso a caso com a gestao. Desfazer tomadas em lote
-- exige backup por identificador de operacao, nunca snapshot cego. Esse backup AINDA NAO EXISTE: e pre-condicao antes de qualquer aplicacao.
-- GUARDA: nao remove a unica via de desfazer enquanto houver tomada nao revertida.
do $g$
begin
  if exists (select 1 from public.assumir_fidelizacao_operacoes where revertida_em is null) then
    raise exception 'ROLLBACK RECUSADO: ha tomadas nao revertidas em assumir_fidelizacao_operacoes. Reverta-as antes (reverter_assumir_fidelizacao) ou trate caso a caso com a gestao.';
  end if;
end
$g$;
drop function if exists public.reverter_assumir_fidelizacao(uuid, text);
drop function if exists public.assumir_caso_fidelizacao_vencida(uuid, text);
