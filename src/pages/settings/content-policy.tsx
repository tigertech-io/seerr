import SettingsContentPolicy from '@app/components/Settings/SettingsContentPolicy';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const ContentPolicyPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsContentPolicy />
    </SettingsLayout>
  );
};

export default ContentPolicyPage;
