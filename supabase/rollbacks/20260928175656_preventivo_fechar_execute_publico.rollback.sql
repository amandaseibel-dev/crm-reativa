-- REVERSÃO de 20260928175656_preventivo_fechar_execute_publico
--
-- Devolve o EXECUTE de PUBLIC às oito funções utilitárias do Preventivo,
-- voltando ao estado em que elas ficaram depois das três migrations de
-- 28/09/2026 (ACL `=X/postgres postgres=X/postgres authenticated=X/postgres
-- service_role=X/postgres`).
--
-- Só faz sentido rodar isto se algo que ninguém previu depender de chamar
-- essas funções como `anon`. Nenhum consumidor conhecido faz isso: nem o
-- front, nem a Edge Function `prev-sincronizar`, nem as RPCs internas (essas
-- rodam como `postgres` por serem SECURITY DEFINER).

do $$
declare f text;
begin
  foreach f in array array[
    'preventivo_hoje()',
    'preventivo_limite_dias()',
    'preventivo_dias_atraso(date)',
    'preventivo_na_janela(date)',
    'preventivo_normalizar_celular(text)',
    'preventivo_email_valido(text)',
    'preventivo_celulares(text)',
    'preventivo_emails(text)'
  ] loop
    execute format('grant execute on function public.%s to public', f);
    -- os dois papéis que importam seguem explícitos de qualquer forma
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end
$$;
