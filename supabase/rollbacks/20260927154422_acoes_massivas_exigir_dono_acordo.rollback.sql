-- Rollback de 20260927190000: campo de "Responsavel pelo acordo" vazio volta a
-- significar "acordo de qualquer pessoa".
--
-- ATENCAO: reverter reabre exatamente o caminho silencioso que esta migration
-- fechou -- previa, exportar e registrar voltam a aceitar ACORDOS_VENCIDOS e
-- MENSALIDADES_E_ACORDOS sem dono de acordo, e acordo de terceiro volta a
-- entrar (medido: ~902 acordos em 27/09/2026). A tela publicada continua
-- exigindo pela guarda propria, entao reverter so o banco deixa as duas pontas
-- discordando.
--
-- Nenhum dado e movido aqui.

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_previa',
$ancora$  -- Campo de acordo VAZIO nao e "qualquer pessoa": nas modalidades que olham
  -- acordo, escolher de quem e o acordo e obrigatorio. Vale tambem para
  -- chamada antiga ('todos', e-mail solto, vazio), que nao traz a dimensao.
  perform internal.acao_massiva_exigir_dono_acordo(p_tipo_cobranca, p_operador_email);

$ancora$,
$novo$$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_exportar',
$ancora$
  -- mesma exigencia da previa, pela mesma funcao: exportar e um caminho que age
  perform internal.acao_massiva_exigir_dono_acordo(p_tipo_cobranca, p_operador_email);$ancora$,
$novo$$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'registrar_acao_massiva',
$ancora$
  -- o tipo vem dos filtros gravados no lote; ausente, vale
  -- MENSALIDADES_E_ACORDOS, que exige o dono do acordo.
  perform internal.acao_massiva_exigir_dono_acordo(
    coalesce(p_filtros, '{}'::jsonb) ->> 'tipo_cobranca', p_operador_email);$ancora$,
$novo$$novo$,
  1);

drop function if exists internal.acao_massiva_exigir_dono_acordo(text,text);
drop function if exists internal.acao_massiva_donos_acordo(text);
