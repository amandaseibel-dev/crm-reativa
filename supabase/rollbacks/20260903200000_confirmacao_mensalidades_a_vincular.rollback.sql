-- Desfaz a fila de mensalidades a vincular e devolve o Possivel Acordo.
--
-- Cuidado: `possivel_acordo` NAO volta com este arquivo -- reaplique
-- 20260828230000_possivel_acordo_pagou_e_parou.sql se quiser a funcao de volta,
-- e restaure src/pages/PossivelAcordo.jsx do historico do git. Lembrando que a
-- tela nunca teve rota: voltar a funcao nao devolve porta de entrada.
drop function if exists public.confirmacao_a_vincular(date, date, text, int, int);

-- Contador volta sem a chave 'a_vincular'. Se `possivel_acordo` nao existir,
-- tirar a linha 'acordo' antes de rodar, senao a funcao quebra ao ser chamada.
create or replace function public.conferencia_contadores()
returns jsonb language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $function$
declare r jsonb;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'vincular',  (select count(*) from public.pagamentos_sem_aluno()),
    'quitar',    (select count(*) from public.quitacao_sugerida(30)),
    'ajustar',   (select coalesce(max(total_faixa),0)
                    from public.conciliacao_santander(date '2026-07-01', 0, 1))
  ) into r;
  return r;
end;
$function$;
