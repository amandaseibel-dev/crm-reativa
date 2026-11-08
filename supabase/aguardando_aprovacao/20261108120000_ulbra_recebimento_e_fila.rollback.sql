-- ============================================================================
-- ROLLBACK de 20261108120000_ulbra_recebimento_e_fila
--
-- Par do artefato de 08/11/2026. Como o SQL original NAO FOI APLICADO, este
-- arquivo tambem nunca rodou.
--
-- SEGURO PORQUE SO DESFAZ O QUE NASCEU ALI. As tres tabelas sao novas e nao
-- existia nada antes delas: nao ha dado anterior para preservar e nenhum
-- objeto existente e tocado. As funcoes sao novas e nenhuma substituiu outra
-- de mesmo nome (conferido em producao em 08/11/2026: nao existe `ulbra_sync_*`
-- nem `ulbra_atendimento_*` no schema public).
--
-- O QUE SE PERDE AO RODAR: o cursor do incremental e o espelho das conversas
-- e dos atendimentos. Nada disso e fonte da verdade -- a fonte e a Mensageria,
-- e a sincronizacao reconstroi lendo de novo. O que NAO volta e o trabalho
-- registrado so aqui: quem assumiu, quem dispensou e com que motivo. Antes de
-- rodar, se houver linha com `responsavel_email` ou `dispensado_em`, copiar:
--
--   create table ulbra_atendimentos_backup_<data> as
--     select * from public.ulbra_atendimentos
--      where responsavel_email is not null or dispensado_em is not null;
--
-- ORDEM: funcoes antes das tabelas, porque sao elas que referenciam.
-- Se o cron do passo 3 ja existir, ele TEM de sair primeiro -- senao continua
-- batendo numa funcao cuja porta de escrita nao existe mais, gastando
-- orcamento da Mensageria e enchendo o log de erro:
--
--   select cron.unschedule('ulbra_sincronizar');
-- ============================================================================

begin;

drop function if exists public.ulbra_conversa_marcar_lida(text);
drop function if exists public.ulbra_atendimento_dispensar(text, text);
drop function if exists public.ulbra_atendimento_assumir(text);
drop function if exists public.ulbra_sync_gravar(jsonb);

drop table if exists public.ulbra_sync_estado;
drop table if exists public.ulbra_atendimentos;
drop table if exists public.ulbra_conversas;

commit;
