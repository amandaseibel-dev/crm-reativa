-- Remove o subsistema de AGENDAMENTO de acoes massivas (nunca usado: 0 registros
-- em toda a historia; campanhas sao geradas no ato via previa + planilha).
-- Mantem intactos: previa, filtros, por_dia, retornos, penetracao, revalidar,
-- registrar_acao_massiva (o fluxo de "geracao dos arquivos"/envio no ato).
-- Nenhuma funcao mantida referencia as tabelas removidas (verificado).
-- Frontend: aba de Agendamento removida de src/pages/AcoesMassivas.jsx (requer deploy).

drop function if exists public.acoes_massivas_agendar(text,text,text,text,jsonb,text,text);
drop function if exists public.acoes_massivas_executar_agendadas();
drop function if exists public.acoes_massivas_cancelar(uuid,text);
drop function if exists public.acoes_massivas_reagendar(uuid,text,text);
drop function if exists public.acoes_massivas_listar(text,text,text);

drop table if exists public.acoes_massivas_destinatarios;
drop table if exists public.acoes_massivas_agendamentos;
