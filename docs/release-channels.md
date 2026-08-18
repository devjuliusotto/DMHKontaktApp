# Fluxo de desenvolvimento e releases

Este projeto possui dois aplicativos Windows instaláveis lado a lado:

| Canal | Nome visível | Identificador | Atualização automática | Envio ao EDV |
| --- | --- | --- | --- | --- |
| Oficial | DMH Kontakte und Kalender | `de.dmh.agendakontakte` | Última release oficial | Ativo |
| Admin Test | DMH Kontakte und Kalender Admin Test | `de.dmh.agendakontakte.admin-test` | Release fixa `admin-test` | Desativado |

Os dois canais usam pastas de dados, banco SQLite, WebView e namespace de credenciais diferentes. A versão Admin Test também exibe uma faixa vermelha permanente. Assim, ela pode ser instalada no mesmo computador sem modificar a instalação oficial.

O Admin Test gera somente o instalador NSIS (`setup.exe`), pois ele aceita versões
pré-release como `0.1.1-beta.1` e é compatível com o updater. A release oficial
continua gerando MSI e NSIS.

O projeto mantém somente o `icons/icon.ico` necessário ao empacotamento Windows. Os
ícones Android, iOS, macOS e duplicatas de tamanhos antigos foram removidos para
reduzir o repositório; o logo exibido na interface continua em `public/`.

## Configuração inicial no GitHub

1. Manter somente a branch `main` como fonte dos builds publicados.
2. Em **Settings > Environments**, criar:
   - `admin-test`, sem aprovação obrigatória;
   - `production`, com o administrador como *required reviewer* e sem autoaprovação, se o plano do repositório disponibilizar essa proteção.
3. Confirmar em **Settings > Secrets and variables > Actions**:
   - em **Variables**: `M365_CLIENT_ID` e `M365_TENANT_ID`;
   - em **Secrets**: `TAURI_SIGNING_PRIVATE_KEY`;
   - em **Secrets**, somente se a chave foi criada com senha:
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, contendo exatamente a senha original;
   - em **Secrets**: `MIGRATION_CAPTURE_URL`.
4. Verificar se **Actions > General > Workflow permissions** permite escrita do `GITHUB_TOKEN`, necessária para publicar releases.

O ambiente `production` funciona como o último portão humano. Se a conta/plano não disponibilizar revisores obrigatórios para este repositório, o workflow continua sendo manual e executa todas as verificações antes de publicar diretamente o commit selecionado da `main`.

## Fluxo automático: push -> Admin Test -> release oficial

Cada `push` para `main` inicia automaticamente o workflow **Admin-Test-Version veröffentlichen**.
Ele testa o commit enviado e, somente depois de compilar e assinar o instalador, substitui a
release prévia rolante `admin-test`. O instalador fica disponível na página dessa release
para download do administrador; o canal Admin Test também pode atualizá-lo pelo próprio updater.

O workflow cancela uma execução antiga quando chegam vários pushes seguidos. Assim, a versão
disponível é sempre a última que terminou com sucesso. A numeração automática usa a versão-base
do `package.json` com `-beta.<número da execução>`.

## Release oficial depois da aprovação do Admin Test

1. Implementar a alteração, fazer commit na `main` e enviá-la ao GitHub.
2. Aguardar `CI` e **Admin-Test-Version veröffentlichen**.
3. Baixar o instalador em `Releases > admin-test` e testá-lo como administrador.
4. Copiar o SHA exibido na release prévia e confirmar que a versão-base existente no código está consistente:

   ```powershell
   npm run version:check
   ```

5. Em **Actions > Offizielle Windows-Version veröffentlichen > Run workflow**, selecionar `main`, informar o SHA testado em `source_ref` e a próxima versão oficial, por exemplo `0.1.1`.
6. Aprovar o ambiente `production`. O workflow só libera a versão se:
    - a versão informada for aplicada e conferida automaticamente em todos os manifestos e lockfiles do build;
    - testes e build passarem;
    - o endpoint EDV e a assinatura de produção estiverem configurados.
7. Depois da publicação, as instalações oficiais consultam `latest.json` automaticamente ao abrir. Se houver uma versão nova, aparece a janela **Neue Version verfuegbar** para baixar e instalar; o instalador é aplicado ao fechar e abrir o app novamente.

## Admin Test manual (quando necessário)

O workflow também continua disponível manualmente para repetir um build específico:

1. Em **Actions > Admin-Test-Version veröffentlichen > Run workflow**, escolher o commit e uma versão como `0.1.1-beta.1`.
2. Instalar ou atualizar o Admin Test e validar com uma cópia dos dados.

Não crie manualmente commits ou tags do tipo `Release vX.Y.Z`. O workflow oficial cria a tag e a release. A versão final é aplicada apenas no ambiente temporário de build, mantendo os manifestos e lockfiles da `main` consistentes.

Se um deploy falhar, abra o resumo da execução em **Actions**. Os workflows de Admin Test e release oficial escrevem uma tabela de resultados no *Step summary* e disponibilizam um artefato `*-diagnostics-...` por 30 dias. O relatório contém somente referências, versões e resultados dos passos; valores de secrets e tokens nunca são incluídos.

Antes de substituir o Admin Test anterior, o workflow constrói e assina integralmente o novo instalador. Assim, uma falha de código, configuração ou empacotamento não remove a última versão de teste funcional.

## Teste local isolado

Para abrir o aplicativo de desenvolvimento no canal Admin Test:

```powershell
npm run tauri:dev:admin-test
```

Para gerar um instalador Admin Test local:

```powershell
npm run tauri:build:admin-test
```

Esses comandos usam outro diretório de dados e deixam o endpoint EDV de produção desativado. O desenvolvimento oficial comum continua disponível com `npm run tauri:dev`.

## Copiar dados reais sem tocar na instalação oficial

1. Na instalação oficial, abrir **Einstellungen > Sicherung**.
2. Criar uma Sicherung JSON e armazená-la temporariamente em local seguro.
3. Abrir o Admin Test e restaurar esse arquivo no mesmo menu.
4. Apagar a cópia quando ela não for mais necessária.

A Sicherung inclui contatos, grupos, calendário e preferências permitidas. Ela exclui senhas, referências secretas e o status de transmissão ao EDV. Uma restauração também não apaga nem reativa o status EDV já existente no aplicativo de destino.

Além da Sicherung manual, o aplicativo mantém automaticamente uma Sicherung cumulativa fora do diretório interno da aplicação, em `Documentos\DMH Kontakte und Kalender\Automatische Sicherung`. Ela é atualizada durante o uso e novamente antes do fechamento. Exclusões são preservadas como elementos históricos; em contatos e compromissos, `Gelöschtes Element` é acrescentado às observações/descrições anteriores. O cofre de senhas do próprio app é salvo separadamente em formato criptografado, sem senhas em texto aberto. O reset completo da instalação não remove essa pasta externa. A restauração dessa Sicherung é uma função oculta nas configurações, exige código de liberação do EDV e deve ser feita somente junto com o EDV no escritório.

## Convenção de versões

- Oficial: `0.1.0`, `0.1.1`, `0.2.0`.
- Admin Test: `0.1.1-beta.1`, `0.1.1-beta.2`, `0.1.1-rc.1`.

A versão-base fica consistente no código. Tanto o sufixo beta do Admin Test quanto o número final escolhido para a release oficial são aplicados no servidor temporário de build; portanto, publicar uma versão não cria commits descartáveis nem deixa manifestos e lockfiles divergentes.

## Primeira publicação 0.1.0

1. Rodar `npm run version:check` e confirmar que todos os arquivos mostram a mesma versão-base.
2. Confirmar que a CI da `main` passou.
3. Fazer push para `main` e validar o Admin Test automático.
4. Executar a release oficial `0.1.0` com o mesmo SHA testado e aprovar `production`.
5. Instalar a release oficial em um PC piloto antes de distribuí-la às usuárias.

## Rollback

Não substitua silenciosamente uma release oficial já distribuída. Se houver defeito em `0.1.1`, corrija na `main`, aguarde o Admin Test automático, teste como `0.1.2-beta.1` e publique `0.1.2`. Guarde os instaladores antigos para recuperação manual, mas prefira sempre avançar com uma versão de correção.
